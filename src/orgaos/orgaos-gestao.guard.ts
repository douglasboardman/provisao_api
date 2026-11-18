import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { exigirRecursoIgreja } from '../feature-flags/feature-flags';

@Injectable()
export class OrgaosGestaoGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    return exigirRecursoIgreja(context, 'orgaos_gestao');
  }
}
