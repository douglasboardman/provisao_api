import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { avaliarExercicio } from '../oficiais/exercicio';
import { hashAto, registrarRequisicao, requisicaoAnterior, transacaoComRetentativa, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const entrada = z.object({ oficial_id: z.uuid(), inicio: dia, evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();
const encerramento = z.object({ data_efeito: dia, autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();

/** Registro técnico da evidência; não confere autoridade pelo perfil de administrador. */
@Injectable()
export class PresidenciaService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(igrejaId: string, usuarioId: string, dados: z.infer<typeof entrada>, transacao?: Prisma.TransactionClient) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados da presidência inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase(), data = new Date(`${v.inicio}T00:00:00.000Z`);
    const contexto = { igreja: igrejaId, usuario: usuarioId, idempotencia, tipo: 'PRESIDENCIA_CONSELHO', hash: hashAto({ operacao: 'PRESIDENCIA_CONSELHO', dados: v }) };
    const executar = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const operador = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const hoje = await hojeDaIgreja(tx, igrejaId);
      const repetido = await requisicaoAnterior(tx, contexto);
      if (repetido) return { id: repetido.id as string };
      if (v.inicio > hoje) throw new BadRequestException('Registro futuro exige conferência institucional.');
      await tx.$queryRaw`SELECT id FROM oficial WHERE id = ${v.oficial_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const vinculado = await tx.oficial.findFirst({ where: { id: v.oficial_id, igreja_id: igrejaId }, select: { pessoa_id: true } });
      if (!vinculado) throw new NotFoundException('Presbítero docente não encontrado nesta igreja.');
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${vinculado.pessoa_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const oficial = await tx.oficial.findFirst({ where: { id: v.oficial_id, igreja_id: igrejaId, tipo: 'PRESBITERO_DOCENTE', pessoa: { sexo: 'MASCULINO' } }, select: { id: true } });
      if (!oficial) throw new NotFoundException('Presbítero docente não encontrado nesta igreja.');
      const vinculos = await tx.vinculo_pastoral.findMany({ where: { igreja_id: igrejaId, oficial_id: oficial.id, exercicio_institucional: true, data_inicio: { lte: data }, OR: [{ data_fim: null }, { data_fim: { gte: data } }] }, take: 2 });
      if (vinculos.length !== 1) throw new BadRequestException('Vínculo pastoral institucional não comprovado ou ambíguo.');
      const eventos = await tx.evento_oficial.findMany({ where: { igreja_id: igrejaId, oficial_id: oficial.id, data_efeito: { lte: data } } });
      const situacao = avaliarExercicio({ data_posse: vinculos[0].data_inicio, termino_previsto: data, termino_efetivo: vinculos[0].data_fim }, eventos, data);
      if (!situacao.em_exercicio) throw new BadRequestException('Docente não está em exercício na data.');
      const registro = await tx.presidencia_conselho.create({ data: { igreja_id: igrejaId, oficial_id: oficial.id, inicio: data, evidencia: v.evidencia, registrado_por: usuarioId } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'presidencia_conselho', registro_id: registro.id, dados_novos: { oficial_id: oficial.id, inicio: v.inicio, evidencia: v.evidencia } } });
      await registrarRequisicao(tx, contexto, { id: registro.id });
      return { id: registro.id };
    };
    return transacao ? executar(transacao) : transacaoComRetentativa(this.prisma, executar, Prisma.TransactionIsolationLevel.ReadCommitted);
  }

  async encerrar(igrejaId: string, usuarioId: string, id: string, dados: z.infer<typeof encerramento>) {
    const parsed = encerramento.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados de encerramento inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const contexto = { igreja: igrejaId, usuario: usuarioId, idempotencia, tipo: 'ENCERRAMENTO_PRESIDENCIA', hash: hashAto({ operacao: 'ENCERRAMENTO_PRESIDENCIA', id, dados: v }) };
    const data = new Date(`${v.data_efeito}T00:00:00.000Z`);
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      if (!await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } })) throw new ForbiddenException('Operador não autorizado.');
      const hoje = await hojeDaIgreja(tx, igrejaId);
      const repetido = await requisicaoAnterior(tx, contexto);
      if (repetido) {
        if (typeof repetido.fim !== 'string') throw new BadRequestException('Resultado anterior indisponível.');
        return { id: repetido.id as string, fim: repetido.fim };
      }
      if (v.data_efeito !== hoje) throw new BadRequestException('Data diferente de hoje exige conferência de impacto.');
      const inicial = await tx.presidencia_conselho.findFirst({ where: { id, igreja_id: igrejaId }, select: { oficial_id: true } });
      if (!inicial) throw new NotFoundException('Presidência não encontrada.');
      await tx.$queryRaw`SELECT id FROM oficial WHERE id = ${inicial.oficial_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const atual = await tx.presidencia_conselho.findFirst({ where: { id, igreja_id: igrejaId } });
      if (!atual || atual.fim || atual.inicio >= data) throw new BadRequestException('Presidência já encerrada ou ordenação do mesmo dia necessária.');
      await tx.presidencia_conselho.update({ where: { id }, data: { fim: data } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'presidencia_conselho', registro_id: id, dados_antigos: { fim: null }, dados_novos: { ...v } } });
      await registrarRequisicao(tx, contexto, { id, fim: v.data_efeito });
      return { id, fim: v.data_efeito };
    });
  }
}
