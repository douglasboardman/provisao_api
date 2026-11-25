import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { atoAnterior, hashAto, registrarRequisicao, requisicaoAnterior, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const dia = z.iso.date().refine(s => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
});
const texto = z.string().trim().min(1).max(1000);
const competencia = z.object({ usuario_id: z.uuid(), inicio: dia, fim: dia.optional(), autoridade: texto.max(255), evidencia: texto, idempotencia: z.uuid() }).strict()
  .refine(v => !v.fim || v.fim >= v.inicio);
const unidade = z.object({ nome: texto.max(255), sigla: z.string().trim().min(1).max(40).optional(), finalidade: texto, constituicao: z.enum(['ELEICAO', 'DESIGNACAO']), data_criacao: dia, evidencia: texto, idempotencia: z.uuid() }).strict();
const encerramento = z.object({ data_fim: dia, autoridade: texto.max(255), evidencia: texto, idempotencia: z.uuid() }).strict();
type Tx = Prisma.TransactionClient;
const dataCivil = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Comandos internos: declarações de competência exigem evidência e não derivam do perfil. */
@Injectable()
export class UnidadesService {
  constructor(private readonly prisma: PrismaService) {}

  async registrarCompetencia(igrejaId: string, operadorId: string, dados: z.infer<typeof competencia>) {
    const parsed = competencia.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados da competência inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const contexto = { igreja: igrejaId, usuario: operadorId, idempotencia, tipo: 'COMPETENCIA_UNIDADES', hash: hashAto({ operacao: 'COMPETENCIA_UNIDADES', dados: v }) };
    if (v.usuario_id === operadorId) throw new ForbiddenException('Não é permitido registrar a própria competência.');
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE igreja_id = ${igrejaId} AND id IN (${operadorId}, ${v.usuario_id}) ORDER BY id FOR UPDATE`;
      const operador = await tx.usuarios.findFirst({ where: { id: operadorId, igreja_id: igrejaId, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const repetido = await requisicaoAnterior(tx, contexto);
      if (repetido) return { id: repetido.id as string };
      const gestor = await tx.usuarios.findFirst({ where: { id: v.usuario_id, igreja_id: igrejaId, ativo: true, perfil: 'GESTOR' }, select: { id: true, pessoa_id: true } });
      if (!gestor?.pessoa_id) throw new NotFoundException('Gestor ativo vinculado a pessoa não encontrado.');
      const registro = await tx.competencia_unidades.create({ data: { igreja_id: igrejaId, usuario_id: gestor.id, pessoa_id: gestor.pessoa_id, registrado_por: operadorId, inicio: dataCivil(v.inicio), fim: v.fim ? dataCivil(v.fim) : null, autoridade: v.autoridade, evidencia: v.evidencia } });
      await this.auditar(tx, igrejaId, operadorId, 'competencia_unidades', registro.id, { usuario_id: gestor.id, pessoa_id: gestor.pessoa_id, inicio: v.inicio, fim: v.fim ?? null });
      await registrarRequisicao(tx, contexto, { id: registro.id });
      return { id: registro.id };
    });
  }

  async criar(igrejaId: string, operadorId: string, dados: z.infer<typeof unidade>) {
    const parsed = unidade.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados da unidade inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase(), data = dataCivil(v.data_criacao);
    const hash = hashAto({ operacao: 'INSTITUICAO_UNIDADE', dados: v });
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${operadorId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const gestor = await tx.usuarios.findFirst({ where: { id: operadorId, igreja_id: igrejaId, ativo: true, perfil: 'GESTOR' }, select: { id: true, pessoa_id: true } });
      if (!gestor?.pessoa_id) throw new ForbiddenException('Gestor institucional vinculado a pessoa é obrigatório.');
      const hoje = dataCivil(await hojeDaIgreja(tx, igrejaId));
      if (data > hoje) throw new BadRequestException('Ato futuro exige conferência institucional.');
      const autoridade = await tx.competencia_unidades.findFirst({ where: { igreja_id: igrejaId, usuario_id: gestor.id, pessoa_id: gestor.pessoa_id, inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: hoje } }] }, select: { id: true } });
      if (!autoridade) throw new ForbiddenException('Competência institucional não comprovada na data do ato.');
      const repetido = await atoAnterior(tx, { igreja: igrejaId, usuario: operadorId, idempotencia, tipo: 'INSTITUICAO', hash }, 'orgao_id');
      if (repetido) {
        if (!repetido.ocupacao_id) throw new BadRequestException('Resultado anterior indisponível.');
        return { id: repetido.ocupacao_id };
      }
      const orgao = await tx.orgao_interno.create({ data: { igreja_id: igrejaId, tipo: 'UNIDADE_MINISTERIAL', constituicao: v.constituicao, nome: v.nome, sigla: v.sigla, finalidade: v.finalidade, data_criacao: data, criador_id: gestor.id, instituidor_id: gestor.pessoa_id, evidencia_instituicao: v.evidencia } });
      const cargos = v.constituicao === 'DESIGNACAO'
        ? [['LIDER', 'Líder'], ['VICE_LIDER', 'Vice-líder']]
        : [['PRESIDENTE', 'Presidente'], ['VICE_PRESIDENTE', 'Vice-presidente'], ['SECRETARIO', 'Secretário'], ['TESOUREIRO', 'Tesoureiro']];
      await tx.cargo_orgao.createMany({ data: cargos.map(([codigo, nome]) => ({ igreja_id: igrejaId, orgao_id: orgao.id, codigo, nome, funcao: codigo })) });
      await tx.$executeRaw`SELECT configurar_orgao_inicial(${orgao.id}, ${igrejaId},
        jsonb_build_object('composicao', ${v.constituicao}::text), 'Ato de instituição da unidade')`;
      await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgao.id, operador_id: operadorId, tipo: 'INSTITUICAO', data_efeito: data, autoridade: gestor.pessoa_id, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { orgao_id: orgao.id, competencia_id: autoridade.id } } });
      await this.auditar(tx, igrejaId, operadorId, 'orgao_interno', orgao.id, { tipo: orgao.tipo, instituicao: v.data_criacao, instituido_por: gestor.pessoa_id, competencia_id: autoridade.id });
      return { id: orgao.id };
    });
  }

  async encerrarCompetencia(igrejaId: string, operadorId: string, id: string, dados: z.infer<typeof encerramento>) {
    const parsed = encerramento.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados de encerramento inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const contexto = { igreja: igrejaId, usuario: operadorId, idempotencia, tipo: 'ENCERRAMENTO_COMPETENCIA_UNIDADES', hash: hashAto({ operacao: 'ENCERRAMENTO_COMPETENCIA_UNIDADES', id, dados: v }) };
    return transacaoSerializavel(this.prisma, async tx => {
      const inicial = await tx.competencia_unidades.findFirst({ where: { id, igreja_id: igrejaId }, select: { usuario_id: true } });
      if (!inicial) throw new NotFoundException('Competência não encontrada.');
      await tx.$queryRaw`SELECT id FROM usuarios WHERE igreja_id = ${igrejaId} AND id IN (${operadorId}, ${inicial.usuario_id}) ORDER BY id FOR UPDATE`;
      const operador = await tx.usuarios.findFirst({ where: { id: operadorId, igreja_id: igrejaId, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
      if (!operador || inicial.usuario_id === operadorId) throw new ForbiddenException('Operador não autorizado.');
      const hoje = dataCivil(await hojeDaIgreja(tx, igrejaId));
      const repetido = await requisicaoAnterior(tx, contexto);
      if (repetido) {
        if (typeof repetido.fim !== 'string') throw new BadRequestException('Resultado anterior indisponível.');
        return { id: repetido.id as string, fim: repetido.fim };
      }
      const registro = await tx.competencia_unidades.findFirst({ where: { id, igreja_id: igrejaId } });
      const dataAto = dataCivil(v.data_fim);
      if (!registro || (registro.fim && (registro.fim <= hoje || registro.fim <= registro.inicio))) throw new BadRequestException('Competência já encerrada.');
      if (dataAto.getTime() !== hoje.getTime()) throw new BadRequestException('Encerramento deve produzir efeito hoje; outros casos exigem conferência de impacto.');
      // Ao cancelar competência futura, um intervalo vazio impede qualquer vigência.
      const fim = registro.inicio > hoje ? registro.inicio : hoje;
      await tx.competencia_unidades.update({ where: { id }, data: { fim } });
      const fimCivil = fim.toISOString().slice(0, 10);
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: operadorId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'competencia_unidades', registro_id: id, dados_antigos: { fim: registro.fim?.toISOString().slice(0, 10) ?? null }, dados_novos: { fim: fimCivil, data_ato: v.data_fim, autoridade: v.autoridade, evidencia: v.evidencia } } });
      await registrarRequisicao(tx, contexto, { id, fim: fimCivil });
      return { id, fim: fimCivil };
    });
  }

  private async auditar(tx: Tx, igrejaId: string, usuarioId: string, tabela: string, id: string, dados: Prisma.InputJsonValue) {
    await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: tabela, registro_id: id, dados_novos: dados } });
  }
}
