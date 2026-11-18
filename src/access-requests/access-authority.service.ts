import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, logs_atividades_acao } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class AccessAuthorityService {
  constructor(private readonly prisma: PrismaService) {}

  async assertReviewer(tx: Prisma.TransactionClient, churchId: string, actorId: string) {
    await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${churchId} FOR UPDATE`;
    const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id: churchId, ativo: true } });
    if (!actor) throw new ForbiddenException('Sem competência para analisar solicitações.');
    if (actor.perfil === 'ADMINISTRADOR') return actor;
    if (actor.perfil === 'GESTOR' && actor.pessoa_id) {
      const authority = await tx.competencia_acesso.findFirst({ where: { igreja_id: churchId, usuario_id: actor.id, pessoa_id: actor.pessoa_id, revogado_em: null }, select: { id: true } });
      if (authority) return actor;
    }
    throw new ForbiddenException('Sem competência para analisar solicitações.');
  }

  async list(churchId: string) {
    return this.prisma.competencia_acesso.findMany({ where: { igreja_id: churchId, revogado_em: null }, select: { id: true, usuario_id: true, pessoa_id: true, referencia: true, concedido_em: true, usuario: { select: { nome_usuario: true, perfil: true, ativo: true, pessoa_id: true } } }, orderBy: { concedido_em: 'desc' } });
  }

  async grant(churchId: string, actorId: string, targetId: string, reference: string) {
    if (actorId === targetId) throw new ForbiddenException('Não é permitido conceder a própria competência.');
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${churchId} FOR UPDATE`;
        const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id: churchId, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
        if (!actor) throw new ForbiddenException('Ação não autorizada.');
        await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${targetId} AND igreja_id = ${churchId} FOR UPDATE`;
        const target = await tx.usuarios.findFirst({ where: { id: targetId, igreja_id: churchId, ativo: true, perfil: 'GESTOR' }, select: { id: true, pessoa_id: true } });
        if (!target) throw new NotFoundException('Gestor ativo não encontrado.');
        if (!target.pessoa_id) throw new BadRequestException('Vincule o gestor a uma pessoa antes de registrar a competência.');
        const authority = await tx.competencia_acesso.create({ data: { igreja_id: churchId, usuario_id: target.id, pessoa_id: target.pessoa_id, referencia: reference, concedido_por: actorId } });
        await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: actorId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'competencia_acesso', registro_id: authority.id, dados_novos: { usuario_id: target.id, pessoa_id: target.pessoa_id } } });
        return { id: authority.id };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Já existe competência vigente para este gestor.');
      throw error;
    }
  }

  async revoke(churchId: string, actorId: string, authorityId: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${churchId} FOR UPDATE`;
      const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id: churchId, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
      if (!actor) throw new ForbiddenException('Ação não autorizada.');
      const authority = await tx.competencia_acesso.findFirst({ where: { id: authorityId, igreja_id: churchId, revogado_em: null } });
      if (!authority) throw new NotFoundException('Competência não encontrada.');
      if (authority.usuario_id === actorId) throw new ForbiddenException('Não é permitido alterar a própria competência.');
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${authority.usuario_id} AND igreja_id = ${churchId} FOR UPDATE`;
      const updated = await tx.competencia_acesso.updateMany({ where: { id: authority.id, igreja_id: churchId, revogado_em: null }, data: { revogado_por: actorId, revogado_em: new Date() } });
      if (updated.count !== 1) throw new ConflictException('Competência já encerrada.');
      await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: actorId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'competencia_acesso', registro_id: authority.id, dados_novos: { revogada: true } } });
      return { message: 'Competência encerrada.' };
    });
  }
}
