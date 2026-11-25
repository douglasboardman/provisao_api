import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, oficial_evento_tipo, oficio_tipo, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { exigirAcessoSensivel } from './acesso-sensivel.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Ator } from '../autorizacao/politica';
import { exigirServicoHistorico } from './autorizacao-historico';

const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const texto = z.string().trim().min(1).max(1000);
const registroSchema = z.object({ pessoa_id: z.string().uuid(), tipo: z.nativeEnum(oficio_tipo), ativo: z.boolean().default(true) }).strict();
const situacaoSchema = z.object({ ativo: z.boolean() }).strict();
const eventoSchema = z.object({ tipo: z.nativeEnum(oficial_evento_tipo), data_efeito: dia, ordem: z.number().int().min(1).max(9999), autoridade: texto, evidencia: texto, observacoes: z.string().trim().max(1000).optional(), evento_restaurado_id: z.string().uuid().optional() }).strict().refine(v => (v.tipo === 'RESTAURACAO') === !!v.evento_restaurado_id);
const encerramentoSchema = z.object({ motivo: texto, autoridade: texto, evidencia: texto }).strict();
const vinculoSchema = z.object({ modalidade: texto, concilio: texto, ato: texto, data_inicio: dia, data_fim: dia.optional(), encerramento: encerramentoSchema.optional(), exercicio_institucional: z.boolean(), evidencia: texto }).strict().refine(v => (!v.data_fim && !v.encerramento) || (!!v.data_fim && !!v.encerramento && v.data_fim >= v.data_inicio));
type Tx = Prisma.TransactionClient;

/** Comandos internos de registro; o operador não representa o órgão que decidiu o ato. */
@Injectable()
export class OficiaisService {
  constructor(private readonly prisma: PrismaService) {}

  private async autorizar(tx: Tx, igrejaId: string, usuarioId: string) {
    const usuario = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR, usuarios_perfil.SECRETARIO] } }, select: { id: true } });
    if (!usuario) throw new ForbiddenException('Operador não autorizado nesta igreja.');
  }
  private async oficialBloqueado(tx: Tx, igrejaId: string, oficialId: string) {
    const registros = await tx.$queryRaw<Array<{ id: string; tipo: oficio_tipo; pessoa_id: string; ativo: boolean }>>`
      SELECT id, tipo, pessoa_id, ativo FROM oficial WHERE id = ${oficialId} AND igreja_id = ${igrejaId} FOR UPDATE`;
    if (!registros.length) throw new NotFoundException('Oficial não encontrado nesta igreja.');
    return registros[0];
  }
  private async auditar(tx: Tx, igrejaId: string, usuarioId: string, tabela: string, id: string, dados: Prisma.InputJsonValue) {
    await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: tabela, registro_id: id, dados_novos: dados } });
  }

  private async conferirOficioAtivo(tx: Tx, igrejaId: string, pessoaId: string) {
    const ativo = await tx.oficial.findFirst({
      where: { igreja_id: igrejaId, pessoa_id: pessoaId, ativo: true },
      select: { id: true },
    });
    if (ativo) throw new ConflictException('Esta pessoa já tem um ofício ativo na igreja.');
  }

  async cadastrar(igrejaId: string, usuarioId: string, dados: z.input<typeof registroSchema>) {
    const validado = registroSchema.safeParse(dados);
    if (!validado.success) throw new BadRequestException('Dados do oficial inválidos.');
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igrejaId, usuarioId);
      const pessoa = await tx.pessoas.findFirst({ where: { id: validado.data.pessoa_id, igreja_id: igrejaId }, select: { id: true } });
      if (!pessoa) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      if (validado.data.ativo) await this.conferirOficioAtivo(tx, igrejaId, pessoa.id);
      const oficial = await tx.oficial.create({ data: { igreja_id: igrejaId, ...validado.data } });
      await this.auditar(tx, igrejaId, usuarioId, 'oficial', oficial.id, { pessoa_id: pessoa.id, tipo: oficial.tipo, ativo: oficial.ativo });
      return oficial;
    });
  }

  async alterarSituacao(igrejaId: string, usuarioId: string, oficialId: string, dados: z.infer<typeof situacaoSchema>) {
    const validado = situacaoSchema.safeParse(dados);
    if (!validado.success) throw new BadRequestException('Situação do ofício inválida.');
    const { ativo } = validado.data;
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igrejaId, usuarioId);
      const atual = await this.oficialBloqueado(tx, igrejaId, oficialId);
      if (atual.ativo === ativo) return { id: atual.id, ativo };
      if (ativo) await this.conferirOficioAtivo(tx, igrejaId, atual.pessoa_id);
      const atualizado = await tx.oficial.update({ where: { id: atual.id }, data: { ativo }, select: { id: true, ativo: true } });
      await tx.logs_atividades.create({ data: {
        igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.ATUALIZACAO,
        tabela_afetada: 'oficial', registro_id: atual.id,
        dados_antigos: { ativo: atual.ativo }, dados_novos: { ativo },
      } });
      return atualizado;
    });
  }

  async registrarEvento(igrejaId: string, usuarioId: string, oficialId: string, dados: z.infer<typeof eventoSchema>, exigirConcessao = false, ator?: Ator) {
    const validado = eventoSchema.safeParse(dados);
    if (!validado.success) throw new BadRequestException('Dados do evento inválidos.');
    const v = validado.data, data = new Date(`${v.data_efeito}T00:00:00.000Z`);
    return this.prisma.$transaction(async tx => {
      await exigirServicoHistorico(tx, igrejaId, usuarioId, 'HISTORICO_OFICIAIS_REGISTRAR', true, ator);
      if (exigirConcessao) await exigirAcessoSensivel(tx, igrejaId, usuarioId, 'registrar');
      await this.oficialBloqueado(tx, igrejaId, oficialId);
      // Alterações retroativas precisam do futuro relatório de impacto; não alterar autoridade silenciosamente.
      const posterior = await tx.evento_oficial.findFirst({ where: { igreja_id: igrejaId, oficial_id: oficialId, OR: [{ data_efeito: { gt: data } }, { data_efeito: data, ordem: { gte: v.ordem } }] }, select: { id: true } });
      if (posterior) throw new BadRequestException('Evento retroativo ou ordem ocupada exige conferência de impacto.');
      const evento = await tx.evento_oficial.create({ data: { igreja_id: igrejaId, oficial_id: oficialId, tipo: v.tipo, data_efeito: data, ordem: v.ordem, autoridade: v.autoridade, evidencia: v.evidencia, observacoes: v.observacoes, evento_restaurado_id: v.evento_restaurado_id } });
      await this.auditar(tx, igrejaId, usuarioId, 'evento_oficial', evento.id, { oficial_id: oficialId, ...v });
      return evento;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async registrarVinculoPastoral(igrejaId: string, usuarioId: string, oficialId: string, dados: z.infer<typeof vinculoSchema>) {
    const validado = vinculoSchema.safeParse(dados);
    if (!validado.success) throw new BadRequestException('Dados do vínculo pastoral inválidos.');
    const v = validado.data;
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igrejaId, usuarioId);
      const oficial = await this.oficialBloqueado(tx, igrejaId, oficialId);
      if (oficial.tipo !== 'PRESBITERO_DOCENTE') throw new BadRequestException('Vínculo pastoral exige presbítero docente.');
      const vinculo = await tx.vinculo_pastoral.create({ data: { igreja_id: igrejaId, oficial_id: oficialId, modalidade: v.modalidade, concilio: v.concilio, ato: v.ato, data_inicio: new Date(`${v.data_inicio}T00:00:00.000Z`), data_fim: v.data_fim ? new Date(`${v.data_fim}T00:00:00.000Z`) : null, motivo_fim: v.encerramento?.motivo, autoridade_fim: v.encerramento?.autoridade, evidencia_fim: v.encerramento?.evidencia, exercicio_institucional: v.exercicio_institucional, evidencia: v.evidencia } });
      await this.auditar(tx, igrejaId, usuarioId, 'vinculo_pastoral', vinculo.id, { oficial_id: oficialId, ...v });
      return vinculo;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async encerrarVinculoPastoral(igrejaId: string, usuarioId: string, vinculoId: string, dados: z.infer<typeof encerramentoSchema> & { data_fim: string }) {
    const validado = encerramentoSchema.extend({ data_fim: dia }).safeParse(dados);
    if (!validado.success) throw new BadRequestException('Dados de encerramento pastoral inválidos.');
    const v = validado.data, fim = new Date(`${v.data_fim}T00:00:00.000Z`);
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igrejaId, usuarioId);
      // Usa a mesma ordem de bloqueio da inclusão de eventos retroativos.
      await tx.$queryRaw`SELECT o.id FROM oficial o JOIN vinculo_pastoral v ON v.oficial_id = o.id AND v.igreja_id = o.igreja_id WHERE v.id = ${vinculoId} AND v.igreja_id = ${igrejaId} FOR UPDATE OF o`;
      const rows = await tx.$queryRaw<Array<{ id: string; data_inicio: Date; data_fim: Date | null }>>`SELECT id, data_inicio, data_fim FROM vinculo_pastoral WHERE id = ${vinculoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const atual = rows[0];
      if (!atual) throw new NotFoundException('Vínculo pastoral não encontrado nesta igreja.');
      if (atual.data_fim || fim < atual.data_inicio) throw new BadRequestException('Vínculo já encerrado ou data anterior ao início.');
      const vinculo = await tx.vinculo_pastoral.update({ where: { id: vinculoId }, data: { data_fim: fim, motivo_fim: v.motivo, autoridade_fim: v.autoridade, evidencia_fim: v.evidencia } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'vinculo_pastoral', registro_id: vinculoId, dados_antigos: { data_fim: null }, dados_novos: { ...v } } });
      return vinculo;
    });
  }

}
