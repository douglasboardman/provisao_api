import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

/** Sessões opacas persistidas, verificadas a cada requisição. */
@Injectable()
export class SessionService {
  static readonly lifetimeMs = 60 * 60 * 1000;
  constructor(private readonly prisma: PrismaService) {}

  private digest(token: string): string | null {
    return /^[a-f0-9]{64}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null;
  }

  newCandidate() {
    const token = randomBytes(32).toString('hex');
    return { token, hash: this.digest(token)! };
  }

  async create(userId: string, churchId: string, authVersion: number, mfaMethod: 'none' | 'totp' | 'recovery' = 'none'): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const hash = this.digest(token)!;
    await this.prisma.$transaction(async tx => {
      // A senha pode ter mudado depois da autenticação; serializar com UPDATE da conta.
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.usuarios.findFirst({ where: { id: userId, igreja_id: churchId, ativo: true, auth_version: authVersion } });
      if (!user) throw new UnauthorizedException('Conta indisponível.');
      await tx.sessoes.create({ data: { usuario_id: user.id, token_hash: hash, auth_version: authVersion, mfa_metodo: mfaMethod === 'none' ? null : mfaMethod, mfa_autenticado_em: mfaMethod === 'none' ? null : new Date(), expira_em: new Date(Date.now() + SessionService.lifetimeMs) } });
    });
    return token;
  }

  async verify(token: string, acknowledge = true) {
    const hash = this.digest(token);
    if (!hash) throw new UnauthorizedException('Sessão inválida.');
    const session = await this.prisma.sessoes.findUnique({ where: { token_hash: hash }, include: { usuario: { include: { igreja: { select: { mfa_obrigatorio: true } }, mfa_credencial: { select: { estado: true } } } } } });
    if (!session || session.revogada_em || session.expira_em <= new Date() || !session.usuario.ativo || session.auth_version !== session.usuario.auth_version) {
      throw new UnauthorizedException('Sessão inválida.');
    }
    if (acknowledge && session.mfa_metodo === 'recovery' && !session.mfa_confirmada_em) {
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${session.usuario_id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM sessoes WHERE id = ${session.id} FOR UPDATE`;
        const live = await tx.sessoes.findUnique({ where: { id: session.id }, include: { usuario: true } });
        if (!live || live.revogada_em || live.expira_em <= new Date() || !live.usuario.ativo || live.usuario.auth_version !== live.auth_version) throw new UnauthorizedException('Sessão inválida.');
        if (live.mfa_confirmada_em) return;
        const reserved = await tx.mfa_recuperacao.updateMany({ where: { usuario_id: live.usuario_id, reserva_sessao_id: live.id, consumido_em: null }, data: { consumido_em: new Date(), reserva_sessao_id: null, reserva_ate: null } });
        if (reserved.count !== 1) throw new UnauthorizedException('Sessão inválida.');
        await tx.sessoes.update({ where: { id: live.id }, data: { mfa_confirmada_em: new Date() } });
        await tx.logs_atividades.create({ data: { igreja_id: live.usuario.igreja_id, usuario_id: live.usuario_id, acao: 'ATUALIZACAO', tabela_afetada: 'mfa_recuperacao', registro_id: live.usuario_id, dados_novos: { usado: true } } });
      });
    }
    const { id, igreja_id, perfil, nome_usuario, email_login, auth_version } = session.usuario;
    const mfa_enrollment_required = (session.usuario.mfa_reinscricao_obrigatoria || (session.usuario.igreja.mfa_obrigatorio && perfil === 'ADMINISTRADOR')) && session.usuario.mfa_credencial?.estado !== 'ATIVO';
    const mfa_recovery_recent = session.mfa_metodo === 'recovery' && !!session.mfa_autenticado_em && session.mfa_autenticado_em > new Date(Date.now() - 10 * 60_000);
    return { id, igreja_id, perfil, nome_usuario, email_login, auth_version, mfa_enrollment_required, mfa_recovery_recent, sessao_id: session.id };
  }

  async revoke(token: string): Promise<void> {
    const hash = this.digest(token);
    if (!hash) return;
    await this.prisma.sessoes.updateMany({ where: { token_hash: hash, revogada_em: null }, data: { revogada_em: new Date() } });
  }
}
