import { SetMetadata } from "@nestjs/common";
import { usuarios_perfil as Perfil } from "@prisma/client";

export const ROLES_KEY = 'roles';

/**
 * Decorator para definir os perfis necessários para acessar um endpoint.
 * Exemplo de uso: @Roles(Perfil.ADMINISTRADOR)
 * @param roles Uma lista de perfis permitidos
 */
export const Roles = (...roles: Perfil[]) => SetMetadata(ROLES_KEY, roles);