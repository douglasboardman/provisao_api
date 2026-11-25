import { ContaComum } from '../autorizacao/politica';
import { Roles } from '../auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { applyDecorators, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { exigirRecursoIgreja } from '../feature-flags/feature-flags';
@Injectable()
export class SecretariaGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    return exigirRecursoIgreja(context, 'secretaria');
  }
}

/** Essas rotas consultam a autorização do contexto e do documento no serviço. */
export const OperacaoContextual = () => applyDecorators(ContaComum(),
  Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR, Perfil.COMUM));
