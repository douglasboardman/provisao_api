import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { usuarios_perfil } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, timingSafeEqual } from 'crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { SessionService } from 'src/auth/session.service';

@Injectable()
export class MfaService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}
  private key() {
    const key = this.config.get<string>('MFA_ENCRYPTION_KEY');
    if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new InternalServerErrorException('MFA não configurado.');
    return Buffer.from(key, 'hex');
  }
  private encrypt(secret: string, id: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(id));
    const value = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), value].map(x => x.toString('base64url')).join('.');
  }
  private decrypt(value: string, id: string): string {
    const parts = value.split('.');
    if (parts.length !== 3) throw new InternalServerErrorException('MFA indisponível.');
    const [iv, tag, encrypted] = parts.map(x => Buffer.from(x, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(tag);
    try { return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'); }
    catch { throw new InternalServerErrorException('MFA indisponível.'); }
  }
  private hash(code: string) { return createHash('sha256').update(code.toLowerCase()).digest('hex'); }

  async status(userId: string, churchId: string) {
    const [mfa, church] = await Promise.all([
      this.prisma.mfa_credencial.findUnique({ where: { usuario_id: userId }, select: { estado: true } }),
      this.prisma.igreja.findUnique({ where: { id: churchId }, select: { mfa_obrigatorio: true } }),
    ]);
    return { enabled: mfa?.estado === 'ATIVO', required: church?.mfa_obrigatorio ?? false };
  }

  async setup(userId: string, churchId: string, password: string) {
    const user = await this.prisma.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true } });
    if (!user || !await bcrypt.compare(password, user.senha_hash)) throw new UnauthorizedException('Credenciais inválidas.');
    if (!user.mfa_reinscricao_obrigatoria && ![usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR].includes(user.perfil as 'ADMINISTRADOR' | 'GESTOR')) throw new ForbiddenException('Configuração não disponível para este perfil.');
    const secret = generateSecret();
    const encrypted = this.encrypt(secret, userId);
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${userId} FOR UPDATE`;
      const current = await tx.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: user.auth_version, OR: [{ perfil: { in: ['ADMINISTRADOR', 'GESTOR'] } }, { mfa_reinscricao_obrigatoria: true }] } });
      if (!current) throw new UnauthorizedException('Conta indisponível.');
      const existing = await tx.mfa_credencial.findUnique({ where: { usuario_id: userId } });
      if (existing?.estado === 'ATIVO') throw new BadRequestException('MFA já está ativo.');
      if (existing?.estado === 'PENDENTE' && existing.expira_em && existing.expira_em > new Date()) throw new BadRequestException('Já existe uma configuração pendente; aguarde expirar.');
      const data = { segredo_cifrado: encrypted, estado: 'PENDENTE', expira_em: new Date(Date.now() + 10 * 60_000), falhas: 0, bloqueado_ate: null };
      await tx.mfa_credencial.upsert({ where: { usuario_id: userId }, create: { usuario_id: userId, ...data }, update: data });
    });
    return { secret, uri: generateURI({ issuer: 'ProVisão', label: user.email_login, secret }) };
  }

  async activate(userId: string, churchId: string, version: number, code: string) {
    const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex'));
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: version, OR: [{ perfil: { in: ['ADMINISTRADOR', 'GESTOR'] } }, { mfa_reinscricao_obrigatoria: true }] } });
      const mfa = await tx.mfa_credencial.findUnique({ where: { usuario_id: userId } });
      if (!user || !mfa || mfa.estado !== 'PENDENTE' || !mfa.expira_em || mfa.expira_em <= new Date() || (mfa.bloqueado_ate && mfa.bloqueado_ate > new Date())) return false;
      const verified = /^\d{6}$/.test(code) ? verifySync({ secret: this.decrypt(mfa.segredo_cifrado, userId), token: code, epochTolerance: 30 }) : { valid: false as const };
      if (!verified.valid || !('timeStep' in verified)) {
        const failures = mfa.falhas + 1;
        await tx.mfa_credencial.update({ where: { usuario_id: userId }, data: { falhas: failures, bloqueado_ate: failures >= 5 ? new Date(Date.now() + 5 * 60_000) : null } });
        return false;
      }
      await tx.mfa_recuperacao.deleteMany({ where: { usuario_id: userId } });
      await tx.mfa_recuperacao.createMany({ data: codes.map(value => ({ usuario_id: userId, hash: this.hash(value) })) });
      await tx.mfa_credencial.update({ where: { usuario_id: userId }, data: { estado: 'ATIVO', expira_em: null, ultimo_passo: verified.timeStep, falhas: 0, bloqueado_ate: null } });
      await tx.usuarios.update({ where: { id: userId }, data: { auth_version: { increment: 1 }, mfa_reinscricao_obrigatoria: false } });
      await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: userId, acao: 'ATUALIZACAO', tabela_afetada: 'mfa_credencial', registro_id: userId, dados_novos: { estado: 'ATIVO' } } });
      return true;
    });
    if (!result) throw new UnauthorizedException('Código inválido, expirado ou temporariamente bloqueado.');
    return { recovery_codes: codes };
  }

  /** Prepara novo lote sem descartar os códigos antigos até confirmação explícita. */
  async regenerate(userId: string, churchId: string, version: number, sessionId: string, password: string, code?: string) {
    const user = await this.prisma.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: version } });
    if (!user || !await bcrypt.compare(password, user.senha_hash)) throw new UnauthorizedException('Credenciais inválidas.');
    const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex'));
    const encrypted = this.encrypt(JSON.stringify(codes), userId);
    const outcome = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${userId} FOR UPDATE`;
      const current = await tx.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: version } });
      const session = await tx.sessoes.findFirst({ where: { id: sessionId, usuario_id: userId, auth_version: version, revogada_em: null, expira_em: { gt: new Date() } } });
      const mfa = await tx.mfa_credencial.findUnique({ where: { usuario_id: userId } });
      if (!current || !session || !mfa || mfa.estado !== 'ATIVO' || (mfa.bloqueado_ate && mfa.bloqueado_ate > new Date())) return 'invalid';
      const activePending = await tx.mfa_recuperacao_pendente.findUnique({ where: { usuario_id: userId } });
      if (activePending && activePending.expira_em > new Date()) return 'pending';
      let valid = false; let step: number | undefined; let factorHash: string | null = null;
      if (code && /^\d{6}$/.test(code)) {
        const result = verifySync({ secret: this.decrypt(mfa.segredo_cifrado, userId), token: code, epochTolerance: 30, afterTimeStep: mfa.ultimo_passo ?? undefined });
        valid = result.valid && 'timeStep' in result;
        if (result.valid && 'timeStep' in result) step = result.timeStep;
      } else if (code && /^[a-f0-9]{24}$/i.test(code)) {
        const hash = this.hash(code);
        const recovery = await tx.mfa_recuperacao.findFirst({ where: { usuario_id: userId, hash, consumido_em: null } });
        const pending = await tx.mfa_recuperacao_pendente.findFirst({ where: { usuario_id: userId, fator_hash: hash, expira_em: { gt: new Date() } } });
        valid = !!recovery && !pending && (!recovery.reserva_sessao_id || !recovery.reserva_ate || recovery.reserva_ate <= new Date());
        if (valid && recovery) {
          if (recovery.reserva_sessao_id) await tx.sessoes.updateMany({ where: { id: recovery.reserva_sessao_id, revogada_em: null }, data: { revogada_em: new Date() } });
          await tx.mfa_recuperacao.update({ where: { id: recovery.id }, data: { reserva_sessao_id: null, reserva_ate: null } });
          factorHash = hash; // Reserva o fator até confirmação ou expiração do lote.
        }
      } else if (!code && session.mfa_metodo === 'recovery' && session.mfa_autenticado_em && session.mfa_autenticado_em > new Date(Date.now() - 10 * 60_000)) {
        valid = true; // Sessão recebeu segundo fator de recuperação há no máximo dez minutos.
      }
      if (!valid) {
        const failures = mfa.falhas + 1;
        await tx.mfa_credencial.update({ where: { usuario_id: userId }, data: { falhas: failures, bloqueado_ate: failures >= 5 ? new Date(Date.now() + 5 * 60_000) : null } });
        await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: userId, acao: 'LOGIN_FALHA', tabela_afetada: 'mfa_recuperacao', registro_id: userId } });
        return 'invalid';
      }
      const data = { sessao_id: sessionId, codigos_cifrados: encrypted, fator_hash: factorHash, expira_em: new Date(Date.now() + 30 * 60_000), falhas: 0 };
      await tx.mfa_recuperacao_pendente.upsert({ where: { usuario_id: userId }, create: { usuario_id: userId, ...data }, update: data });
      await tx.mfa_credencial.update({ where: { usuario_id: userId }, data: { falhas: 0, bloqueado_ate: null, ...(step === undefined ? {} : { ultimo_passo: step }) } });
      await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: userId, acao: 'ATUALIZACAO', tabela_afetada: 'mfa_recuperacao', registro_id: userId, dados_novos: { preparacao: true } } });
      return 'ok';
    });
    if (outcome === 'pending') throw new BadRequestException('Já existe uma renovação pendente; retome-a ou aguarde expirar.');
    if (outcome !== 'ok') throw new UnauthorizedException('Código inválido ou temporariamente bloqueado.');
    return { recovery_codes: codes };
  }

  /** Remove somente lotes temporários já expirados, sem alterar códigos ativos. */
  async clearExpiredPending() {
    return this.prisma.mfa_recuperacao_pendente.deleteMany({ where: { expira_em: { lte: new Date() } } });
  }

  async resumeRecovery(userId: string, churchId: string, version: number, sessionId: string, password: string) {
    const user = await this.prisma.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: version } });
    if (!user || !await bcrypt.compare(password, user.senha_hash)) throw new UnauthorizedException('Credenciais inválidas.');
    const pending = await this.prisma.mfa_recuperacao_pendente.findFirst({ where: { usuario_id: userId, sessao_id: sessionId, expira_em: { gt: new Date() }, falhas: { lt: 5 }, sessao: { usuario_id: userId, revogada_em: null, auth_version: version, expira_em: { gt: new Date() } } } });
    if (!pending) throw new NotFoundException('Nenhuma renovação pendente nesta sessão.');
    return { recovery_codes: JSON.parse(this.decrypt(pending.codigos_cifrados, userId)) as string[] };
  }

  async confirmRecovery(userId: string, churchId: string, version: number, sessionId: string, code: string) {
    const success = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM sessoes WHERE id = ${sessionId} AND usuario_id = ${userId} FOR UPDATE`;
      const user = await tx.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: version } });
      const pending = await tx.mfa_recuperacao_pendente.findFirst({ where: { usuario_id: userId, sessao_id: sessionId, expira_em: { gt: new Date() }, falhas: { lt: 5 }, sessao: { usuario_id: userId, revogada_em: null, auth_version: version, expira_em: { gt: new Date() } } } });
      if (!user || !pending) return false;
      const codes = JSON.parse(this.decrypt(pending.codigos_cifrados, userId)) as string[];
      const inputHash = Buffer.from(this.hash(code), 'hex');
      const match = /^[a-f0-9]{24}$/i.test(code) && codes.some(value => timingSafeEqual(Buffer.from(this.hash(value), 'hex'), inputHash));
      if (!match) { await tx.mfa_recuperacao_pendente.update({ where: { usuario_id: userId }, data: { falhas: { increment: 1 } } }); return false; }
      await tx.mfa_recuperacao.deleteMany({ where: { usuario_id: userId } });
      await tx.mfa_recuperacao.createMany({ data: codes.map(value => ({ usuario_id: userId, hash: this.hash(value), consumido_em: this.hash(value) === this.hash(code) ? new Date() : null })) });
      await tx.mfa_recuperacao_pendente.delete({ where: { usuario_id: userId } });
      await tx.sessoes.update({ where: { id: sessionId }, data: { mfa_metodo: null, mfa_autenticado_em: null } });
      await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: userId, acao: 'ATUALIZACAO', tabela_afetada: 'mfa_recuperacao', registro_id: userId, dados_novos: { renovados: true } } });
      return true;
    });
    if (!success) throw new UnauthorizedException('Código inválido ou renovação indisponível.');
    return { message: 'Novos códigos confirmados; o código usado nesta confirmação não poderá ser reutilizado.' };
  }

  async setPolicy(userId: string, churchId: string, version: number, password: string, code: string, required: boolean) {
    const user = await this.prisma.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: version, perfil: 'ADMINISTRADOR' }, include: { mfa_credencial: true } });
    if (!user || user.mfa_credencial?.estado !== 'ATIVO' || !await bcrypt.compare(password, user.senha_hash)) throw new UnauthorizedException('Credenciais inválidas.');
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('Informe o código do aplicativo autenticador.');
    if (required) {
      try {
        const publicKey = createPublicKey(this.config.get<string>('MFA_RECOVERY_PUBLIC_KEY') ?? '');
        if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('tipo inválido');
      } catch { throw new BadRequestException('Configure a chave pública Ed25519 para recuperação excepcional antes de exigir MFA.'); }
    }
    if (required && await this.prisma.mfa_recuperacao.count({ where: { usuario_id: userId, consumido_em: null } }) === 0) throw new BadRequestException('Renove seus códigos de recuperação antes de exigir MFA.');
    await this.verifyLogin(userId, churchId, version, code);
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${churchId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${userId} FOR UPDATE`;
      const current = await tx.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: version, perfil: 'ADMINISTRADOR' }, include: { mfa_credencial: true } });
      if (!current || current.mfa_credencial?.estado !== 'ATIVO') throw new UnauthorizedException('Conta indisponível.');
      if (required && await tx.mfa_recuperacao.count({ where: { usuario_id: userId, consumido_em: null } }) === 0) throw new BadRequestException('Renove seus códigos de recuperação antes de exigir MFA.');
      await tx.igreja.update({ where: { id: churchId }, data: { mfa_obrigatorio: required } });
      await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: userId, acao: 'ATUALIZACAO', tabela_afetada: 'igreja', registro_id: churchId, dados_novos: { mfa_obrigatorio: required } } });
    });
    return { required };
  }

  async verifyLogin(userId: string, churchId: string, version: number, code?: string, sessionHash?: string) {
    const outcome = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: version } });
      if (!user) return 'invalid';
      const mfa = await tx.mfa_credencial.findUnique({ where: { usuario_id: userId } });
      const createSession = async (method: 'none' | 'totp' | 'recovery') => {
        if (!sessionHash) return null;
        return tx.sessoes.create({ data: { usuario_id: userId, token_hash: sessionHash, auth_version: version, mfa_metodo: method === 'none' ? null : method, mfa_autenticado_em: method === 'none' ? null : new Date(), expira_em: new Date(Date.now() + SessionService.lifetimeMs) }, select: { id: true } });
      };
      if (!mfa || mfa.estado !== 'ATIVO') { await createSession('none'); return 'none'; }
      if (!code) return 'required';
      if (mfa.bloqueado_ate && mfa.bloqueado_ate > new Date()) return 'invalid';
      let valid = false;
      let usedRecovery = false;
      let recoveryId: string | undefined;
      let previousSessionId: string | null = null;
      let step: number | undefined;
      if (/^\d{6}$/.test(code)) {
        const result = verifySync({ secret: this.decrypt(mfa.segredo_cifrado, userId), token: code, epochTolerance: 30, afterTimeStep: mfa.ultimo_passo ?? undefined });
        valid = result.valid && 'timeStep' in result;
        if (result.valid && 'timeStep' in result) step = result.timeStep;
      } else if (/^[a-f0-9]{24}$/i.test(code)) {
        const hash = this.hash(code);
        const pending = await tx.mfa_recuperacao_pendente.findFirst({ where: { usuario_id: userId, fator_hash: hash, expira_em: { gt: new Date() } }, select: { usuario_id: true } });
        if (!pending && sessionHash) {
          const recovery = await tx.mfa_recuperacao.findFirst({ where: { usuario_id: userId, hash, consumido_em: null } });
          if (recovery && (!recovery.reserva_sessao_id || !recovery.reserva_ate || recovery.reserva_ate <= new Date())) {
            valid = true;
            usedRecovery = true;
            recoveryId = recovery.id;
            previousSessionId = recovery.reserva_sessao_id;
          }
        }
      }
      if (valid) {
        await tx.mfa_credencial.update({ where: { usuario_id: userId }, data: { falhas: 0, bloqueado_ate: null, ...(step === undefined ? {} : { ultimo_passo: step }) } });
        if (previousSessionId) await tx.sessoes.updateMany({ where: { id: previousSessionId, revogada_em: null }, data: { revogada_em: new Date() } });
        const method = usedRecovery ? 'recovery' : 'totp';
        const session = await createSession(method);
        if (usedRecovery && recoveryId && session) {
          await tx.mfa_recuperacao.update({ where: { id: recoveryId }, data: { reserva_sessao_id: session.id, reserva_ate: new Date(Date.now() + 30_000) } });
        }
        return method;
      }
      const failures = mfa.falhas + 1;
      await tx.mfa_credencial.update({ where: { usuario_id: userId }, data: { falhas: failures, bloqueado_ate: failures >= 5 ? new Date(Date.now() + 5 * 60_000) : null } });
      await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: userId, acao: 'LOGIN_FALHA', tabela_afetada: 'auth', registro_id: userId, dados_novos: { etapa: 'mfa' } } });
      return 'invalid';
    });
    if (outcome === 'required') throw new UnauthorizedException({ statusCode: 401, code: 'MFA_REQUIRED', message: 'Código de autenticação necessário.' });
    if (outcome !== 'none' && outcome !== 'totp' && outcome !== 'recovery') throw new UnauthorizedException('Código inválido, reservado ou temporariamente bloqueado. Se acabou de tentar, aguarde e tente novamente.');
    return outcome;
  }
}
