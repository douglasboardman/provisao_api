import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { ROLES_KEY } from 'src/auth/decorators/roles.decorator';
import { contaDaSessao, decidirServico, type Servico } from 'src/autorizacao/politica';
import { estadoDaLiberacao, exigirOperacaoDisponivel, exigirRotaLegada, type ServicoLiberavel } from 'src/autorizacao/liberacao-servico';
import { PrismaService } from 'src/prisma/prisma.service';

export const ALL_ROLES = Object.values(Perfil);
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest();
    if (!user) return false;
    const targets = [context.getHandler(), context.getClass()];
    const retirada = this.reflector.get<ServicoLiberavel>('rota_legada_de', context.getHandler());
    if (retirada) exigirRotaLegada(await estadoDaLiberacao(this.prisma, user.igreja_id, retirada));
    const handlerRoles = this.reflector.get<Perfil[]>(ROLES_KEY, context.getHandler());
    const servico = this.reflector.get<Servico>('servico_da_rota', context.getHandler()) ??
      ((handlerRoles?.length === 1 && handlerRoles[0] === Perfil.ADMINISTRADOR) || this.reflector.get('aceita_conta_comum', context.getHandler()) ? undefined :
        this.reflector.get<Servico>('servico_da_rota', context.getClass()));
    if (servico) return this.prisma.$transaction(async tx => {
      exigirOperacaoDisponivel(await estadoDaLiberacao(tx, user.igreja_id, servico));
      return (await decidirServico(tx, await contaDaSessao(tx, user), servico)).permite;
    });
    const roles = this.reflector.getAllAndOverride<Perfil[]>(ROLES_KEY, targets);
    return !roles || roles.includes(user.perfil);
  }
}
