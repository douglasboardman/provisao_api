import { Injectable, UnauthorizedException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';
import { OutboxService } from 'src/outbox/outbox.service';
import { LogsService } from 'src/logs/logs.service';
import { logs_atividades_acao } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/** Número de rounds do bcrypt para hash de senhas. */
const BCRYPT_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly outbox: OutboxService,
    private readonly logsService: LogsService,
  ) {}

  // ─── Autenticação ────────────────────────────────────────────────────────────

  /**
   * Autentica um usuário e retorna um token JWT de sessão.
   * @param login E-mail cadastrado na igreja.
   * @param pass Senha em texto plano.
   * @param igreja_id Igreja selecionada pelo usuário.
   * @returns Objeto com o `access_token` de sessão.
   * @throws {UnauthorizedException} Se as credenciais forem inválidas ou a conta estiver inativa.
   */
  async signIn(login: string, pass: string, igreja_id: string): Promise<{ access_token: string }> {
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM usuarios WHERE igreja_id = ${igreja_id} AND lower(btrim(email_login)) = lower(btrim(${login})) LIMIT 2`;
    const user = ids.length === 1 ? await this.prisma.usuarios.findUnique({ where: { id: ids[0].id } }) : null;

    if (!user) throw new UnauthorizedException('Credenciais inválidas.');

    if (!user.ativo) {
      await this.logsService.registrar({
        igreja_id: user.igreja_id,
        usuario_id: user.id,
        acao: logs_atividades_acao.LOGIN_FALHA,
        tabela_afetada: 'auth',
        registro_id: user.id,
      });
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    const isPasswordMatching = await bcrypt.compare(pass, user.senha_hash);
    if (!isPasswordMatching) {
      await this.logsService.registrar({
        igreja_id: user.igreja_id,
        usuario_id: user.id,
        acao: logs_atividades_acao.LOGIN_FALHA,
        tabela_afetada: 'auth',
        registro_id: user.id,
      });
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    const payload = {
      sub: user.id,
      username: user.nome_usuario,
      login: user.email_login,
      perfil: user.perfil,
      igreja_id: user.igreja_id,
      auth_version: user.auth_version,
    };

    const access_token = await this.jwtService.signAsync(payload);


    return { access_token };
  }

  async logSuccessfulLogin(userId: string, igrejaId: string): Promise<void> {
    await this.logsService.registrar({ igreja_id: igrejaId, usuario_id: userId, acao: logs_atividades_acao.LOGIN_SUCESSO, tabela_afetada: 'auth', registro_id: userId });
  }

  // ─── Ativação e definição de senha ───────────────────────────────────────────

  /** Aprovação e enfileiramento são atômicos; SMTP é executado pelo worker. */
  async activateAndQueue(userId: string, igrejaId: string, actorId: string): Promise<void> {
    await this.createPasswordToken(userId, igrejaId, null, 'password_setup', 48 * 60 * 60 * 1000, true, actorId);
  }

  async reissueSetup(userId: string, igrejaId: string, actorId: string): Promise<void> {
    const user = await this.prisma.usuarios.findFirst({ where: { id: userId, igreja_id: igrejaId, ativo: true } });
    if (!user) throw new NotFoundException('Conta não encontrada ou inativa.');
    await this.createPasswordToken(userId, igrejaId, user.email_login, 'password_setup', 48 * 60 * 60 * 1000, false, actorId);
  }

  /**
   * Define ou redefine a senha do usuário a partir de um token válido.
   * Aceita tokens de `password_setup` (ativação) e `password_reset` (esqueci minha senha).
   * @param token Token aleatório de operação de senha.
   * @param novaSenha Nova senha em texto plano.
   * @returns Mensagem de confirmação.
   */
  async setPassword(token: string, novaSenha: string): Promise<{ message: string }> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('Token inválido ou expirado.');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const senha_hash = await bcrypt.hash(novaSenha, BCRYPT_SALT_ROUNDS);
    await this.prisma.$transaction(async tx => {
      const candidate = await tx.token_senha.findUnique({ where: { hash } });
      if (!candidate) throw new UnauthorizedException('Token inválido ou expirado.');
      // Serializa consumo e emissão com alterações de conta que usam UPDATE.
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${candidate.usuario_id} FOR UPDATE`;
      const user = await tx.usuarios.findUnique({ where: { id: candidate.usuario_id } });
      if (!user || !user.ativo || user.auth_version !== candidate.auth_version ||
          !['password_setup', 'password_reset'].includes(candidate.finalidade)) {
        throw new UnauthorizedException('Token inválido ou expirado.');
      }
      const result = await tx.token_senha.updateMany({
        where: { id: candidate.id, consumido_em: null, revogado_em: null, expira_em: { gt: new Date() } },
        data: { consumido_em: new Date() },
      });
      if (result.count !== 1) throw new UnauthorizedException('Token inválido ou expirado.');
      await tx.usuarios.update({ where: { id: user.id }, data: { senha_hash, auth_version: { increment: 1 } } });
      await tx.solicitacao_acesso.updateMany({ where: { usuario_id: user.id, igreja_id: user.igreja_id, estado: 'APROVADA', situacao_acesso: 'CONVITE_PENDENTE' }, data: { situacao_acesso: 'ATIVADA' } });
      await tx.token_senha.updateMany({ where: { usuario_id: user.id, consumido_em: null, revogado_em: null }, data: { revogado_em: new Date() } });
    });

    return { message: 'Senha definida com sucesso. Você já pode fazer login.' };
  }

  // ─── Esqueci minha senha ──────────────────────────────────────────────────────

  /**
   * Inicia o fluxo de recuperação de senha.
   * Envia um e-mail com link de redefinição se o endereço corresponder
   * a uma conta ativa. Por segurança, sempre retorna a mesma resposta
   * independentemente de o e-mail existir ou não (evita enumeração).
   * @param email_login E-mail do usuário.
   * @param igreja_id Igreja selecionada pelo usuário.
   * @returns Mensagem genérica de confirmação.
   */
  async forgotPassword(email_login: string, igreja_id: string): Promise<{ message: string }> {
    const genericResponse = {
      message: 'Se o e-mail informado estiver cadastrado, você receberá as instruções em breve.',
    };

    const ids = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM usuarios WHERE igreja_id = ${igreja_id} AND lower(btrim(email_login)) = lower(btrim(${email_login})) LIMIT 2`;
    const user = ids.length === 1 ? await this.prisma.usuarios.findUnique({ where: { id: ids[0].id } }) : null;
    if (!user || !user.ativo) return genericResponse;

    try {
      await this.createPasswordToken(user.id, user.igreja_id, user.email_login, 'password_reset', 60 * 60 * 1000, false);
    } catch {
      // Resposta pública não informa se a conta existe; erro operacional é sanitizado.
      this.logger.warn('Falha ao enfileirar recuperação de senha.');
    }

    return genericResponse;
  }

  // O token é mantido como hash; seu conteúdo na fila é cifrado com chave externa ao banco.
  private async createPasswordToken(userId: string, igrejaId: string, email: string | null, finalidade: 'password_setup' | 'password_reset', lifetimeMs: number, activate: boolean, actorId?: string): Promise<void> {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const placeholder = activate ? await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_SALT_ROUNDS) : undefined;
    await this.prisma.$transaction(async tx => {
      if (actorId) {
        await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${igrejaId} FOR UPDATE`;
        const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id: igrejaId, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
        if (!actor) throw new UnauthorizedException('Ação não autorizada.');
      }
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${userId} FOR UPDATE`;
      const found = await tx.usuarios.findFirst({ where: { id: userId, igreja_id: igrejaId } });
      if (!found) throw new NotFoundException('Conta não encontrada.');
      if (activate && found.ativo) throw new BadRequestException('Esta conta já está ativa.');
      if (!activate && (!found.ativo || found.email_login !== email)) throw new UnauthorizedException('Conta indisponível.');
      const user = activate
        ? await tx.usuarios.update({ where: { id: userId }, data: { ativo: true, senha_hash: placeholder, auth_version: { increment: 1 } } })
        : found;
      await tx.token_senha.updateMany({ where: { usuario_id: userId, finalidade, consumido_em: null, revogado_em: null }, data: { revogado_em: new Date() } });
      const entry = await tx.token_senha.create({ data: { usuario_id: userId, hash, finalidade, auth_version: user.auth_version, expira_em: new Date(Date.now() + lifetimeMs) } });
      await this.outbox.enqueue(tx, entry.id, token);
    });
  }
}
