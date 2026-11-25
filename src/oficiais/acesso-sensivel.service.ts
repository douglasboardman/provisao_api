import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

const concessaoSchema = z.object({ usuario_id: z.string().uuid(), pode_consultar: z.boolean(), pode_registrar: z.boolean(), fundamento: z.string().trim().min(1).max(1000) }).strict().refine(v => v.pode_consultar || v.pode_registrar);
const revogacaoSchema = z.object({ motivo: z.string().trim().min(1).max(1000) }).strict();
type Tx = Prisma.TransactionClient;

/** Mantém a concessão bloqueada até o commit do ato ou da consulta. */
export async function exigirAcessoSensivel(tx: Tx, igrejaId: string, usuarioId: string, acao: 'consultar' | 'registrar') {
  const rows = acao === 'consultar'
    ? await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM acesso_eventos_sensiveis WHERE igreja_id = ${igrejaId} AND usuario_id = ${usuarioId} AND revogado_em IS NULL AND pode_consultar = true FOR SHARE`
    : await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM acesso_eventos_sensiveis WHERE igreja_id = ${igrejaId} AND usuario_id = ${usuarioId} AND revogado_em IS NULL AND pode_registrar = true FOR SHARE`;
  if (!rows.length) throw new ForbiddenException('Esta operação exige concessão específica.');
}

@Injectable()
export class AcessoSensivelService {
  constructor(private readonly prisma: PrismaService) {}
  private async administrador(tx: Tx, igrejaId: string, usuarioId: string) {
    const user = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: usuarios_perfil.ADMINISTRADOR }, select: { id: true, pessoa_id: true } });
    if (!user) throw new ForbiddenException('Operador não autorizado.');
    return user;
  }
  async conceder(igrejaId: string, usuarioId: string, dados: z.infer<typeof concessaoSchema>) {
    const parsed = concessaoSchema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Concessão inválida.');
    const v = parsed.data;
    if (v.usuario_id === usuarioId) throw new ForbiddenException('Não é permitido conceder acesso a si próprio.');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE igreja_id = ${igrejaId} AND id IN (${usuarioId}, ${v.usuario_id}) ORDER BY id FOR SHARE`;
      const admin = await this.administrador(tx, igrejaId, usuarioId);
      const alvo = await tx.usuarios.findFirst({ where: { id: v.usuario_id, igreja_id: igrejaId, ativo: true, perfil: { in: [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR, usuarios_perfil.SECRETARIO, usuarios_perfil.AUDITOR, usuarios_perfil.COMUM] } }, select: { id: true, perfil: true, pessoa_id: true } });
      if (!alvo) throw new NotFoundException('Usuário elegível não encontrado nesta igreja.');
      if (admin.pessoa_id && admin.pessoa_id === alvo.pessoa_id) throw new ForbiddenException('Não é permitido conceder acesso a outra conta própria.');
      if (alvo.perfil === usuarios_perfil.AUDITOR && v.pode_registrar) throw new BadRequestException('Auditor pode receber somente acesso de consulta.');
      const concessao = await tx.acesso_eventos_sensiveis.create({ data: { igreja_id: igrejaId, usuario_id: alvo.id, concedido_por_id: usuarioId, pode_consultar: v.pode_consultar, pode_registrar: v.pode_registrar, fundamento: v.fundamento } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'acesso_eventos_sensiveis', registro_id: concessao.id, dados_novos: { usuario_id: alvo.id, pode_consultar: v.pode_consultar, pode_registrar: v.pode_registrar } } });
      return concessao;
    });
  }
  async revogar(igrejaId: string, usuarioId: string, id: string, dados: z.infer<typeof revogacaoSchema>) {
    const parsed = revogacaoSchema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Motivo de revogação inválido.');
    return this.prisma.$transaction(async tx => {
      await this.administrador(tx, igrejaId, usuarioId);
      const rows = await tx.$queryRaw<Array<{ id: string; revogado_em: Date | null }>>`SELECT id, revogado_em FROM acesso_eventos_sensiveis WHERE id = ${id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Concessão não encontrada nesta igreja.');
      if (rows[0].revogado_em) throw new BadRequestException('Concessão já revogada.');
      const resultado = await tx.acesso_eventos_sensiveis.update({ where: { id }, data: { revogado_em: new Date(), revogado_por_id: usuarioId, motivo_revogacao: parsed.data.motivo } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'acesso_eventos_sensiveis', registro_id: id, dados_novos: { revogada: true } } });
      return resultado;
    });
  }
  async consultarEventos(igrejaId: string, usuarioId: string, oficialId: string) {
    return this.prisma.$transaction(async tx => {
      await exigirAcessoSensivel(tx, igrejaId, usuarioId, 'consultar');
      const oficial = await tx.oficial.findFirst({ where: { id: oficialId, igreja_id: igrejaId }, select: { id: true } });
      if (!oficial) throw new NotFoundException('Oficial não encontrado nesta igreja.');
      const eventos = await tx.evento_oficial.findMany({ where: { igreja_id: igrejaId, oficial_id: oficialId, tipo: { not: 'ORDENACAO' } }, orderBy: [{ data_efeito: 'asc' }, { ordem: 'asc' }] });
      const registros = await tx.logs_atividades.findMany({ where: { igreja_id: igrejaId, tabela_afetada: 'evento_oficial', acao: logs_atividades_acao.CRIACAO, registro_id: { in: eventos.map(e => e.id) } }, select: { registro_id: true, created_at: true, usuarios: { select: { nome_usuario: true } } }, orderBy: { created_at: 'asc' } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'eventos_sensiveis_consulta', registro_id: oficialId } });
      return eventos.map(evento => { const registro = registros.find(r => r.registro_id === evento.id); return { ...evento, registrado_por: registro ? { nome: registro.usuarios.nome_usuario, data: registro.created_at } : null }; });
    });
  }
}
