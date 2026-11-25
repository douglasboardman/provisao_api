import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { SessionService } from './session.service';
import { assertCsrf, sessionCookie } from './csrf';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService, private readonly config: ConfigService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      assertCsrf(request, this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001');
    }
    const token = sessionCookie(request);
    if (!token) throw new UnauthorizedException('Sessão não encontrada.');
    const user = await this.sessions.verify(token);
    if (user.mfa_enrollment_required) {
      const allowed = (request.method === 'GET' && ['/auth/profile', '/auth/mfa'].includes(request.path)) ||
        (request.method === 'POST' && ['/auth/mfa/setup', '/auth/mfa/activate', '/auth/logout'].includes(request.path));
      if (!allowed) throw new ForbiddenException('Configure a autenticação em duas etapas para continuar.');
    }
    if (user.perfil === 'COMUM' && !Reflect.getMetadata('aceita_conta_comum', context.getHandler()) &&
        !Reflect.getMetadata('servico_em_comparacao', context.getHandler()) && !Reflect.getMetadata('servico_da_rota', context.getHandler())) {
      throw new ForbiddenException('Ação indisponível para a conta comum.');
    }
    request['user'] = { sub: user.id, igreja_id: user.igreja_id, perfil: user.perfil, auth_version: user.auth_version, username: user.nome_usuario, login: user.email_login, mfa_enrollment_required: user.mfa_enrollment_required, mfa_recovery_recent: user.mfa_recovery_recent, sessao_id: user.sessao_id };
    return true;
  }
}
