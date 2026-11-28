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
  Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM));

/** Rotas que verificam também o mandato para leitura ou classificação da ata. */
export const ConsultaContextualAtas = () => applyDecorators(ContaComum(), Roles(...Object.values(Perfil)));
