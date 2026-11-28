import { decidirServico } from '../autorizacao/politica';
import { estadoDaLiberacao, exigirOperacaoDisponivel } from '../autorizacao/liberacao-servico';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, logs_atividades_acao } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class AccessAuthorityService {
  constructor(private readonly prisma: PrismaService) {}

  async assertReviewer(tx: Prisma.TransactionClient, churchId: string, actorId: string, acao: 'ACESSO_CONSULTAR' | 'ACESSO_ANALISAR' = 'ACESSO_ANALISAR') {
    await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${churchId} FOR SHARE`;
    const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id: churchId, ativo: true } });
    if (!actor) throw new ForbiddenException('Sem competência para analisar solicitações.');
    const estado = await estadoDaLiberacao(tx, churchId, acao);
    exigirOperacaoDisponivel(estado);
    if ((await decidirServico(tx, actor, acao)).permite) return actor;
    throw new ForbiddenException('Atribuição vigente necessária para analisar solicitações.');
  }

}
