import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { estado_documental_historico, fato_historico_oficial, logs_atividades_acao, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { exigirAcessoSensivel } from './acesso-sensivel.service';
const dataCivil = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const opcional = (max: number) => z.string().trim().min(1).max(max).nullable();
const schema = z.object({ tipo: z.nativeEnum(fato_historico_oficial), data_evento: dataCivil.nullable(), data_descricao: opcional(255), situacao_documental: z.nativeEnum(estado_documental_historico), referencia_externa: opcional(1000), autoridade: opcional(255), idempotencia: z.string().uuid() }).strict().refine(v => v.situacao_documental !== 'EXTERNO_CONFERIDO' || !!v.referencia_externa);
type Entrada = z.infer<typeof schema>;
@Injectable()
export class AcervoHistoricoService {
  constructor(private readonly prisma: PrismaService) {}
  private async operador(tx: Prisma.TransactionClient, igrejaId: string, usuarioId: string) {
    const usuario = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR, usuarios_perfil.SECRETARIO] } }, select: { id: true } });
    if (!usuario) throw new ForbiddenException('Operador não autorizado nesta igreja.');
  }
  async registrar(igrejaId: string, usuarioId: string, oficialId: string, entrada: Entrada) {
    const parsed = schema.safeParse(entrada);
    if (!parsed.success) throw new BadRequestException('Dados históricos inválidos.');
    const v = { ...parsed.data, idempotencia: parsed.data.idempotencia.toLowerCase() };
    return this.prisma.$transaction(async tx => {
      await this.operador(tx, igrejaId, usuarioId);
      const oficial = await tx.oficial.findFirst({ where: { id: oficialId, igreja_id: igrejaId }, select: { id: true } });
      if (!oficial) throw new NotFoundException('Oficial não encontrado nesta igreja.');
      // Trava por igreja/chave antes de consultar, inclusive entre requisições concorrentes.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igrejaId + ':' + v.idempotencia}, 0))`;
      const anterior = await tx.registro_historico_oficial.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igrejaId, idempotencia: v.idempotencia } } });
      if (anterior) {
        const mesmaData = (anterior.data_evento?.toISOString().slice(0, 10) ?? null) === v.data_evento;
        if (anterior.criado_por_id !== usuarioId || anterior.oficial_id !== oficialId || anterior.tipo !== v.tipo || !mesmaData || anterior.data_descricao !== v.data_descricao || anterior.situacao_documental !== v.situacao_documental || anterior.referencia_externa !== v.referencia_externa || anterior.autoridade !== v.autoridade) throw new ConflictException('Chave de repetição já utilizada para outro registro.');
        return anterior;
      }
      const registro = await tx.registro_historico_oficial.create({ data: { igreja_id: igrejaId, oficial_id: oficialId, criado_por_id: usuarioId, tipo: v.tipo, data_evento: v.data_evento ? new Date(`${v.data_evento}T00:00:00.000Z`) : null, data_descricao: v.data_descricao, situacao_documental: v.situacao_documental, referencia_externa: v.referencia_externa, autoridade: v.autoridade, idempotencia: v.idempotencia } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'registro_historico_oficial', registro_id: registro.id, dados_novos: { oficial_id: oficialId, tipo: v.tipo, situacao_documental: v.situacao_documental } } });
      return registro;
    });
  }
  async listar(igrejaId: string, oficialId: string) {
    const oficial = await this.prisma.oficial.findFirst({ where: { id: oficialId, igreja_id: igrejaId }, select: { id: true } });
    if (!oficial) throw new NotFoundException('Oficial não encontrado nesta igreja.');
    return this.prisma.registro_historico_oficial.findMany({ where: { igreja_id: igrejaId, oficial_id: oficialId }, select: { id: true, tipo: true, data_evento: true, situacao_documental: true, criado_em: true }, orderBy: [{ criado_em: 'desc' }, { id: 'asc' }] });
  }
  async detalhe(igrejaId: string, usuarioId: string, id: string) {
    return this.prisma.$transaction(async tx => {
      await exigirAcessoSensivel(tx, igrejaId, usuarioId, 'consultar');
      const registro = await tx.registro_historico_oficial.findFirst({ where: { id, igreja_id: igrejaId }, select: { id: true, oficial_id: true, tipo: true, data_evento: true, data_descricao: true, situacao_documental: true, referencia_externa: true, autoridade: true, criado_em: true, criado_por: { select: { nome_usuario: true } } } });
      if (!registro) throw new NotFoundException('Registro histórico não encontrado nesta igreja.');
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'acervo_historico_consulta', registro_id: id } });
      return registro;
    });
  }
}
