import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { ROLES_KEY } from 'src/auth/decorators/roles.decorator';
import { camposConta, comparar, contaDaSessao, decidirServico, type Servico } from 'src/autorizacao/politica';
import { estadoDaLiberacao, exigirOperacaoDisponivel, exigirRotaLegada, type ServicoLiberavel } from 'src/autorizacao/liberacao-servico';
import { PrismaService } from 'src/prisma/prisma.service';

export const ALL_ROLES = Object.values(Perfil).filter(perfil => perfil !== 'COMUM');

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Perfil[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    const { user } = context.switchToHttp().getRequest();
    const servico = this.reflector.get<Servico | undefined>('servico_da_rota', context.getHandler());
    const acao = this.reflector.get<Servico | undefined>('servico_em_comparacao', context.getHandler());
    const antiga = this.reflector.get<ServicoLiberavel | undefined>('rota_legada_de', context.getHandler());
    const permitido = !(acao && user?.perfil === 'COMUM') && (!roles || (!!user && roles.includes(user.perfil)));
    if (antiga && user && permitido) {
      const estado = await estadoDaLiberacao(this.prisma, user.igreja_id, antiga);
      const nome = context.getHandler().name;
      try {
        await this.prisma.$transaction(async tx => {
          const conta = await contaDaSessao(tx, user);
          await tx.evento_autorizacao.create({ data: { igreja_id: conta.igreja_id, operador_id: conta.id,
            operador_pessoa_id: conta.pessoa_id, acao: 'USO_ROTA_LEGADA', recurso_id: antiga,
            fundamento: 'Acompanhamento da retirada de rota de mandato', dados: { operacao: nome, estado } } });
        });
      } catch {
        this.logger.warn('Não foi possível registrar a consulta à política da rota legada de ' + antiga);
      }
      exigirRotaLegada(estado);
    }
    if (servico && user) {
      const estado = await estadoDaLiberacao(this.prisma, user.igreja_id, servico);
      exigirOperacaoDisponivel(estado);
      if (estado === 'ATRIBUICAO' || user.perfil === 'COMUM') {
        return this.prisma.$transaction(async tx => {
          const conta = await contaDaSessao(tx, user);
          const decisao = await decidirServico(tx, conta, servico);
          if (acao || estado === 'ATRIBUICAO') await comparar(tx, conta, servico, conta.igreja_id, permitido, decisao, 'GUARDA_DE_PERFIL');
          return decisao.permite;
        });
      }
    }
    if (acao && user) {
      try {
        await this.prisma.$transaction(async tx => {
          const conta = await tx.usuarios.findFirstOrThrow({ where: { id: user.sub, igreja_id: user.igreja_id }, select: camposConta });
          await comparar(tx, conta, acao, conta.igreja_id, permitido, await decidirServico(tx, conta, acao), 'GUARDA_DE_PERFIL');
        });
      } catch {
        this.logger.warn('Não foi possível registrar a comparação da operação ' + acao);
      }
    }
    return permitido;
  }
}
