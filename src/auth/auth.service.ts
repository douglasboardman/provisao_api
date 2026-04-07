import { Injectable, UnauthorizedException, NotFoundException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/email/email.service';
import { Email } from 'src/core/classes/email.class';
import { usuarios_perfil } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/** Sufixo adicionado ao JWT_SECRET para tokens de operações de senha.
 *  Impede que tokens de autenticação sejam reutilizados como tokens de redefinição. */
const PWD_TOKEN_SUFFIX = '_PWD_OPS';

/** Número de rounds do bcrypt para hash de senhas. */
const BCRYPT_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  // ─── Autenticação ────────────────────────────────────────────────────────────

  /**
   * Autentica um usuário e retorna um token JWT de sessão.
   * @param login E-mail ou nome de usuário.
   * @param pass Senha em texto plano.
   * @returns Objeto com o `access_token` de sessão.
   * @throws {UnauthorizedException} Se as credenciais forem inválidas ou a conta estiver inativa.
   */
  async signIn(login: string, pass: string): Promise<{ access_token: string }> {
    const isEmail = Email.isEmail(login);

    const user = isEmail
      ? await this.prisma.usuarios.findFirst({ where: { email_login: login } })
      : await this.prisma.usuarios.findFirst({ where: { nome_usuario: login } });

    if (!user) throw new UnauthorizedException('Credenciais inválidas.');

    if (!user.ativo) {
      throw new UnauthorizedException('Conta inativa. Aguarde a aprovação do administrador.');
    }

    const isPasswordMatching = await bcrypt.compare(pass, user.senha_hash);
    if (!isPasswordMatching) throw new UnauthorizedException('Credenciais inválidas.');

    const payload = {
      sub: user.id,
      username: user.nome_usuario,
      login: user.email_login,
      perfil: user.perfil,
      igreja_id: user.igreja_id,
    };

    return { access_token: await this.jwtService.signAsync(payload) };
  }

  // ─── Registro de novo usuário ─────────────────────────────────────────────────

  /**
   * Registra uma solicitação de cadastro de novo usuário.
   * O usuário é criado com `ativo: false` e sem senha definida.
   * O administrador precisará aprovar e ativar a conta.
   * @param nome_usuario Nome de usuário desejado.
   * @param email_login E-mail do solicitante.
   * @param igreja_id ID da igreja à qual o usuário deseja se vincular.
   * @returns Mensagem de confirmação do registro.
   * @throws {ConflictException} Se o e-mail já estiver cadastrado na mesma igreja.
   */
  async register(nome_usuario: string, email_login: string, igreja_id: string): Promise<{ message: string }> {
    const existing = await this.prisma.usuarios.findFirst({ where: { email_login, igreja_id } });
    if (existing) {
      throw new ConflictException('Este e-mail já está cadastrado nesta igreja.');
    }

    // Gera um hash placeholder impossível de ser utilizado para login direto
    const placeholderHash = await bcrypt.hash(
      crypto.randomBytes(32).toString('hex'),
      BCRYPT_SALT_ROUNDS,
    );

    await this.prisma.usuarios.create({
      data: {
        nome_usuario,
        email_login,
        igreja_id,
        senha_hash: placeholderHash,
        perfil: usuarios_perfil.OPERADOR,
        ativo: false,
      },
    });

    return {
      message: 'Solicitação de cadastro enviada com sucesso. Aguarde a aprovação do administrador.',
    };
  }

  // ─── Ativação e definição de senha ───────────────────────────────────────────

  /**
   * Gera um token de configuração de senha (usado na ativação pelo admin)
   * e envia o e-mail de boas-vindas com o link de acesso.
   * Deve ser chamado APÓS `ativo` já ter sido definido como `true`.
   * @param userId ID do usuário.
   * @param igreja_id ID da igreja (para verificação de posse).
   */
  async sendPasswordSetupEmail(userId: string, igreja_id: string): Promise<void> {
    const user = await this.prisma.usuarios.findFirst({ where: { id: userId, igreja_id } });
    if (!user) throw new NotFoundException('Usuário não encontrado.');

    const token = await this.signPasswordToken(user.id, 'password_setup', '48h');
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    const setupUrl = `${frontendUrl}/auth/set-password?token=${token}`;

    await this.emailService.sendPasswordSetup(user.nome_usuario, user.email_login, setupUrl);
  }

  /**
   * Define ou redefine a senha do usuário a partir de um token válido.
   * Aceita tokens de `password_setup` (ativação) e `password_reset` (esqueci minha senha).
   * @param token Token JWT de operação de senha.
   * @param novaSenha Nova senha em texto plano.
   * @returns Mensagem de confirmação.
   */
  async setPassword(token: string, novaSenha: string): Promise<{ message: string }> {
    const payload = await this.verifyPasswordToken(token, ['password_setup', 'password_reset']);

    const user = await this.prisma.usuarios.findUnique({ where: { id: payload.sub } });
    if (!user || !user.ativo) {
      throw new UnauthorizedException('Token inválido ou conta inativa.');
    }

    const senha_hash = await bcrypt.hash(novaSenha, BCRYPT_SALT_ROUNDS);
    await this.prisma.usuarios.update({ where: { id: user.id }, data: { senha_hash } });

    return { message: 'Senha definida com sucesso. Você já pode fazer login.' };
  }

  // ─── Esqueci minha senha ──────────────────────────────────────────────────────

  /**
   * Inicia o fluxo de recuperação de senha.
   * Envia um e-mail com link de redefinição se o endereço corresponder
   * a uma conta ativa. Por segurança, sempre retorna a mesma resposta
   * independentemente de o e-mail existir ou não (evita enumeração).
   * @param email_login E-mail do usuário.
   * @returns Mensagem genérica de confirmação.
   */
  async forgotPassword(email_login: string): Promise<{ message: string }> {
    const genericResponse = {
      message: 'Se o e-mail informado estiver cadastrado, você receberá as instruções em breve.',
    };

    const user = await this.prisma.usuarios.findFirst({
      where: { email_login, ativo: true },
    });

    if (!user) return genericResponse;

    try {
      const token = await this.signPasswordToken(user.id, 'password_reset', '1h');
      const frontendUrl = this.configService.get<string>('FRONTEND_URL');
      const resetUrl = `${frontendUrl}/auth/set-password?token=${token}`;

      await this.emailService.sendPasswordReset(user.nome_usuario, user.email_login, resetUrl);
    } catch {
      // Falha silenciosa: não expõe se o e-mail existe no sistema
    }

    return genericResponse;
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────────

  /**
   * Assina um token JWT de operação de senha com secret dedicado e expiração definida.
   */
  private async signPasswordToken(userId: string, purpose: string, expiresIn: string): Promise<string> {
    const secret = this.configService.get<string>('JWT_SECRET') + PWD_TOKEN_SUFFIX;
    return this.jwtService.signAsync({ sub: userId, purpose }, { secret, expiresIn });
  }

  /**
   * Verifica e decodifica um token JWT de operação de senha,
   * garantindo que seu propósito (`purpose`) esteja na lista de propósitos aceitos.
   * @throws {UnauthorizedException} Se o token for inválido, expirado ou com propósito incorreto.
   */
  private async verifyPasswordToken(
    token: string,
    allowedPurposes: string[],
  ): Promise<{ sub: string; purpose: string }> {
    let payload: { sub: string; purpose: string };

    try {
      const secret = this.configService.get<string>('JWT_SECRET') + PWD_TOKEN_SUFFIX;
      payload = await this.jwtService.verifyAsync<{ sub: string; purpose: string }>(token, { secret });
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado.');
    }

    // Verificação de propósito fora do try/catch para não ser engolida pelo handler genérico
    if (!allowedPurposes.includes(payload.purpose)) {
      throw new UnauthorizedException('Token inválido para esta operação.');
    }

    return payload;
  }
}
