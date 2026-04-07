import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { ROLES_KEY } from 'src/auth/decorators/roles.decorator';

export const ALL_ROLES = Object.values(Perfil) as Perfil[];

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector){}

  canActivate(context: ExecutionContext): boolean {

    /**
     * Obtém os perfis requeridos para a rota, definidos com o decorator @Roles,
     * Atribui os valores à constante requiredRoles procura por metadados 
     * identificados pela chave ROLES_KEY. A busca deve ser feita primeiro no método do 
     * controller (getHandler), ou seja, na rota e, se nada for encontrado lá, a busca 
     * deve continuar na classe do controller (getClass). O primeiro valor encontrado 
     * tem prioridade e será retornado, e espera-se que este valor seja um Array de Perfil."
     */
    const requiredRoles = this.reflector.getAllAndOverride<Perfil[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()] // Handler = rota, Class = Controller
    );

    if (!requiredRoles) { return true }

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      return false;
    }
    
    return requiredRoles.some((role) => user.perfil === role);
  }
}
