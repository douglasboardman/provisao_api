import {
  Body,
  Controller,
  Post,
  Get,
  Request,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignInDto } from './dto/sign-in.dto';
import { RegisterDto } from './dto/register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AuthGuard } from './auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Autentica o usuário e retorna um token JWT de sessão.
   * Rota: POST /auth/login
   */
  @HttpCode(HttpStatus.OK)
  @Post('login')
  signIn(@Body() signInDto: SignInDto) {
    return this.authService.signIn(signInDto.login, signInDto.senha);
  }

  /**
   * Registra uma solicitação de cadastro de novo usuário.
   * O usuário é criado com `ativo: false` e sem senha. O administrador
   * precisará ativar a conta, momento em que o e-mail de definição de
   * senha será enviado automaticamente.
   * Rota: POST /auth/register
   */
  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(
      registerDto.nome_usuario,
      registerDto.email_login,
      registerDto.igreja_id,
    );
  }

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
    return this.authService.forgotPassword(dto.email_login);
  }

  /**
   * Retorna o perfil do usuário logado extraído do token JWT.
   * Rota: GET /auth/profile
   */
  @UseGuards(AuthGuard)
  @Get('profile')
  getProfile(@Request() req: any) {
    return req.user;
  }
}
