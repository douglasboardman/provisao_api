import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { exigirRecursoIgreja } from '../feature-flags/feature-flags';

@Injectable()
export class OrgaosGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    return exigirRecursoIgreja(context, 'governanca', 'orgaos');
  }
}
