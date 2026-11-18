import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { exigirRecursoIgreja } from '../feature-flags/feature-flags';
@Injectable()
export class SecretariaGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    return exigirRecursoIgreja(context, 'secretaria');
  }
}
