import {
  Body,
  Controller,
  Post,
  Get,
  Request,
  HttpCode,
  HttpStatus,
  UseGuards,
  Res,
  Header,
  Patch,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignInDto } from './dto/sign-in.dto';
import { RegisterDto } from './dto/register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AuthGuard } from './auth.guard';
import { MfaService } from 'src/mfa/mfa.service';
import { MfaSetupDto, MfaActivateDto, MfaRecoveryDto, MfaPolicyDto, MfaResumeDto, MfaConfirmRecoveryDto } from 'src/mfa/mfa.dto';
import { ConfirmAccessDto } from './dto/confirm-access.dto';
import { AccessRequestsService } from 'src/access-requests/access-requests.service';
import { SessionService } from './session.service';
import { assertCsrf, sessionCookie } from './csrf';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request as ExpressRequest, Response } from 'express';
import { recursosDaSessao } from '../feature-flags/feature-flags';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService, private readonly sessions: SessionService, private readonly jwt: JwtService, private readonly config: ConfigService, private readonly accessRequests: AccessRequestsService, private readonly mfa: MfaService) {}

  /**
   * Autentica o usuário e retorna um token JWT de sessão.
   * Rota: POST /auth/login
   */
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async signIn(@Body() dto: SignInDto, @Request() req: ExpressRequest, @Res({ passthrough: true }) res: Response) {
    assertCsrf(req, this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001');
    const result = await this.authService.signIn(dto.login, dto.senha, dto.igreja_id);
    const payload = await this.jwt.verifyAsync(result.access_token);
    const candidate = this.sessions.newCandidate();
    await this.mfa.verifyLogin(payload.sub, payload.igreja_id, payload.auth_version, dto.mfa_code, candidate.hash);
    const token = candidate.token;
    const user = await this.sessions.verify(token, false);
    await this.authService.logSuccessfulLogin(user.id, user.igreja_id);
    res.cookie('provisao_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SessionService.lifetimeMs });
    return { sub: user.id, igreja_id: user.igreja_id, perfil: user.perfil, username: user.nome_usuario, login: user.email_login, mfa_enrollment_required: user.mfa_enrollment_required, mfa_recovery_recent: user.mfa_recovery_recent, recursos: recursosDaSessao(user.igreja_id) };
  }

  @UseGuards(AuthGuard)
  @Get('mfa')
  @Header('Cache-Control', 'no-store')
  mfaStatus(@Request() req) { return this.mfa.status(req.user.sub, req.user.igreja_id); }

  @UseGuards(AuthGuard)
  @Post('mfa/setup')
  @Header('Cache-Control', 'no-store')
  setupMfa(@Request() req, @Body() dto: MfaSetupDto) { return this.mfa.setup(req.user.sub, req.user.igreja_id, dto.senha); }

  @UseGuards(AuthGuard)
  @Post('mfa/activate')
  @Header('Cache-Control', 'no-store')
  activateMfa(@Request() req, @Body() dto: MfaActivateDto) { return this.mfa.activate(req.user.sub, req.user.igreja_id, req.user.auth_version, dto.codigo); }

  @UseGuards(AuthGuard)
  @Post('mfa/recovery')
  @Header('Cache-Control', 'no-store')
  renewRecovery(@Request() req, @Body() dto: MfaRecoveryDto) { return this.mfa.regenerate(req.user.sub, req.user.igreja_id, req.user.auth_version, req.user.sessao_id, dto.senha, dto.codigo); }

  @UseGuards(AuthGuard)
  @Post('mfa/recovery/resume')
  @Header('Cache-Control', 'no-store')
  resumeRecovery(@Request() req, @Body() dto: MfaResumeDto) { return this.mfa.resumeRecovery(req.user.sub, req.user.igreja_id, req.user.auth_version, req.user.sessao_id, dto.senha); }

  @UseGuards(AuthGuard)
  @Post('mfa/recovery/confirm')
  @Header('Cache-Control', 'no-store')
  confirmRecovery(@Request() req, @Body() dto: MfaConfirmRecoveryDto) { return this.mfa.confirmRecovery(req.user.sub, req.user.igreja_id, req.user.auth_version, req.user.sessao_id, dto.codigo); }

  @UseGuards(AuthGuard)
  @Patch('mfa/policy')
  @Header('Cache-Control', 'no-store')
  mfaPolicy(@Request() req, @Body() dto: MfaPolicyDto) { return this.mfa.setPolicy(req.user.sub, req.user.igreja_id, req.user.auth_version, dto.senha, dto.codigo, dto.obrigatorio); }

  @UseGuards(AuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Request() req: ExpressRequest, @Res({ passthrough: true }) res: Response) {
    const token = sessionCookie(req);
    if (token) await this.sessions.revoke(token);
    res.clearCookie('provisao_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  }

  /**
   * Registra uma solicitação de cadastro de novo usuário.
   * A conta só é criada após confirmação do canal e aprovação.
   * Rota: POST /auth/register
   */
  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.accessRequests.requestAccess(registerDto.igreja_id, registerDto.nome_usuario, registerDto.email_login);
  }

  @Post('confirm-access')
  @HttpCode(HttpStatus.OK)
  confirmAccess(@Body() dto: ConfirmAccessDto) { return this.accessRequests.confirm(dto.token); }

  @Post('cancel-access')
  @HttpCode(HttpStatus.OK)
  cancelAccess(@Body() dto: ConfirmAccessDto) { return this.accessRequests.cancel(dto.token); }

  /**
   * Recebe o token de configuração inicial de senha (enviado por e-mail na ativação)
   * ou de redefinição ("esqueci minha senha") e define a nova senha do usuário.
   * Rota: POST /auth/set-password
   */
  @HttpCode(HttpStatus.OK)
  @Post('set-password')
  setPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.setPassword(dto.token, dto.nova_senha);
  }

  /**
   * Inicia o fluxo de recuperação de senha. Envia um e-mail com link
   * de redefinição se o endereço corresponder a uma conta ativa.
   * Retorna sempre a mesma resposta para evitar enumeração de e-mails.
   * Rota: POST /auth/forgot-password
   */
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email_login, dto.igreja_id);
  }

  /**
   * Retorna o perfil do usuário logado extraído do token JWT.
   * Rota: GET /auth/profile
   */
  @UseGuards(AuthGuard)
  @Get('profile')
  getProfile(@Request() req: any) {
    const { sub, igreja_id, perfil, username, login, mfa_enrollment_required, mfa_recovery_recent } = req.user;
    return { sub, igreja_id, perfil, username, login, mfa_enrollment_required, mfa_recovery_recent, recursos: recursosDaSessao(igreja_id) };
  }
}
