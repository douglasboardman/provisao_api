import type { Ator } from '../autorizacao/politica';
import { exigirServicoHistorico } from './autorizacao-historico';
import { revisarOrgaosNaAplicacao } from '../orgaos/revisao-aplicacao';
import { conflitoDeIdempotencia, transacaoComRetentativa } from '../orgaos/idempotencia';
import { consumirDecisaoEleitoral } from './consumir-decisao-eleitoral';
import { createHash } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, membresia_rol, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { exigirAcessoSensivel } from './acesso-sensivel.service';
import { impactoOrgaos, DetalheVinculoOrgao } from './impacto-orgaos';
const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const propostaSchema = z.object({ data_evento: dia, itens: z.array(z.object({ evento_id: z.string().uuid(), ordem: z.number().int().min(1).max(9999) }).strict()).min(1).max(100) }).strict().refine(v => new Set(v.itens.map(i => i.evento_id)).size === v.itens.length && new Set(v.itens.map(i => i.ordem)).size === v.itens.length);
const aplicarSchema = propostaSchema.extend({ hash_previa: z.string().regex(/^[a-f0-9]{64}$/), decisao_id: z.string().uuid().optional(), decisoes_orgao: z.array(z.uuid()).min(1).max(50).optional(), justificativa: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.string().uuid(), ciente: z.literal(true) }).strict();
const unicaSchema = z.object({ ordem: z.number().int().min(1).max(9999), justificativa: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.string().uuid(), ciente: z.literal(true) }).strict();
type Unica = z.infer<typeof unicaSchema>;
type Proposta = z.infer<typeof propostaSchema>; type Aplicacao = z.infer<typeof aplicarSchema>; type Tx = Prisma.TransactionClient;
const civil = (d: Date) => d.toISOString().slice(0, 10);
@Injectable()
export class OrdenacaoMembresiaService {
  constructor(private readonly prisma: PrismaService) {}
  /** Uso interno após autorização e bloqueio do alvo na transação chamadora. */
  async calcularParaOrgaos(tx: Tx, igreja: string, alvo: string, dados: unknown, porPessoa: boolean, coletar?: (detalhes: DetalheVinculoOrgao[]) => void) {
    const parsed = propostaSchema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Proposta inválida.');
    return this.calcular(tx, igreja, alvo, parsed.data, porPessoa, coletar);
  }
  private async autorizar(tx: Tx, igreja: string, usuario: string, modo: 'consultar' | 'registrar', ator?: Ator) {
    const escrita = modo === 'registrar';
    await exigirServicoHistorico(tx, igreja, usuario, escrita ? 'HISTORICO_MEMBRESIA_RETIFICAR' : 'HISTORICO_MEMBRESIA_CONSULTAR', escrita, ator);
    await exigirAcessoSensivel(tx, igreja, usuario, modo);
  }
  private async pessoaDoAlvo(tx: Tx, igreja: string, id: string, porPessoa: boolean) {
    if (porPessoa) {
      const pessoa = await tx.pessoas.findFirst({ where: { id, igreja_id: igreja }, select: { id: true } });
      if (!pessoa) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      return pessoa.id;
    }
    const oficial = await tx.oficial.findFirst({ where: { id, igreja_id: igreja }, select: { pessoa_id: true } });
    if (!oficial) throw new NotFoundException('Oficial não encontrado nesta igreja.');
    return oficial.pessoa_id;
  }
  async eventosPessoa(igreja: string, usuario: string, pessoaId: string, ator?: Ator) {
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'consultar', ator);
      await this.pessoaDoAlvo(tx, igreja, pessoaId, true);
      const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoaId }, select: { id: true, tipo_evento: true, data_evento: true, ordem_dia: true, rol: true }, orderBy: [{ data_evento: 'desc' }, { id: 'asc' }] });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_ordenacao_membresia', registro_id: pessoaId } });
      return eventos;
    });
  }
  private async calcular(tx: Tx, igreja: string, oficialId: string, proposta: Proposta, porPessoa = false, coletar?: (detalhes: DetalheVinculoOrgao[]) => void) {
    const pessoaId = await this.pessoaDoAlvo(tx, igreja, oficialId, porPessoa);
    const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoaId }, select: { id: true, data_evento: true, ordem_dia: true, tipo_evento: true, motivacao_evento: true, rol: true, rol_origem: true, updated_at: true }, orderBy: [{ data_evento: 'asc' }, { id: 'asc' }] });
    const grupo = eventos.filter(e => civil(e.data_evento) === proposta.data_evento);
    const ordens = new Map(proposta.itens.map(i => [i.evento_id, i.ordem]));
    if (grupo.length !== proposta.itens.length || grupo.some(e => !ordens.has(e.id))) throw new BadRequestException('Informe exatamente todos os eventos da data, com ordens distintas.');
    if (grupo.every(e => e.ordem_dia === ordens.get(e.id))) throw new BadRequestException('A ordem proposta não altera o histórico.');
    const projetados = eventos.map(e => ({ ...e, ordem_dia: ordens.get(e.id) ?? e.ordem_dia }));
    const data = new Date(`${proposta.data_evento}T00:00:00.000Z`), anterior = new Date(data); anterior.setUTCDate(anterior.getUTCDate() - 1);
    const antesDoDia = eventoVigente(eventos, anterior);
    let rolAnterior = antesDoDia.situacao === 'DEFINIDO' ? antesDoDia.evento.rol : undefined;
    const inconsistencias: string[] = [];
    for (const e of [...grupo].sort((a, b) => ordens.get(a.id)! - ordens.get(b.id)!)) {
      if (e.tipo_evento === 'MUDANCA_DE_ROL' && (!rolAnterior || e.rol_origem !== rolAnterior)) inconsistencias.push(e.id);
      rolAnterior = e.rol;
    }
    const posterior = eventos.filter(e => e.data_evento > data);
    if (posterior.length) {
      const primeiroDia = posterior.reduce((menor, evento) => Math.min(menor, evento.data_evento.getTime()), Number.POSITIVE_INFINITY);
      const proximoGrupo = posterior.filter(e => e.data_evento.getTime() === primeiroDia);
      const ordensProximas = proximoGrupo.map(e => e.ordem_dia);
      if (proximoGrupo.length > 1 && (ordensProximas.some(o => o == null) || new Set(ordensProximas).size !== ordensProximas.length)) inconsistencias.push(...proximoGrupo.map(e => e.id));
      else {
        const primeiro = proximoGrupo.length === 1 ? proximoGrupo[0] : [...proximoGrupo].sort((a, b) => a.ordem_dia! - b.ordem_dia!)[0];
        if (primeiro.tipo_evento === 'MUDANCA_DE_ROL' && primeiro.rol_origem !== rolAnterior) inconsistencias.push(primeiro.id);
      }
    }
    const mandatos = await tx.mandato_oficial.findMany({ where: { igreja_id: igreja, oficial: { pessoa_id: pessoaId }, OR: [{ termino_efetivo: { gte: data } }, { termino_efetivo: null, termino_previsto: { gte: data } }] }, select: { id: true, data_eleicao: true, data_posse: true, termino_previsto: true, termino_efetivo: true }, orderBy: { id: 'asc' } });
    const rolEm = (lista: typeof eventos, d: Date) => { const r = eventoVigente(lista, d); return r.situacao === 'DEFINIDO' ? r.evento.rol : 'INDETERMINADO'; };
    const analise = mandatos.map(m => ({ id: m.id, eleicao: civil(m.data_eleicao), posse: civil(m.data_posse), termino: civil(m.termino_efetivo ?? m.termino_previsto), rol_eleicao_antes: rolEm(eventos, m.data_eleicao), rol_eleicao_depois: rolEm(projetados, m.data_eleicao), rol_posse_antes: rolEm(eventos, m.data_posse), rol_posse_depois: rolEm(projetados, m.data_posse) }));
    const conferencias = await tx.conferencia_eleicao_oficial.findMany({ where: { igreja_id: igreja, pessoa_id: pessoaId, data_eleicao: { gte: data } }, select: { id: true, data_eleicao: true }, orderBy: { id: 'asc' } });
    const eventoEm = (lista: typeof eventos, d: Date) => { const r = eventoVigente(lista, d); return r.situacao === 'DEFINIDO' ? r.evento.id : r.situacao; };
    const conferenciasImpacto = conferencias.map(c => ({ id: c.id, data_eleicao: civil(c.data_eleicao), evento_antes: eventoEm(eventos, c.data_eleicao), evento_depois: eventoEm(projetados, c.data_eleicao) }));
    const conferenciaAlterada = conferenciasImpacto.some(c => c.evento_antes !== c.evento_depois);
    const invalida = analise.some(m => (m.rol_eleicao_antes !== m.rol_eleicao_depois && m.rol_eleicao_depois !== membresia_rol.COMUNGANTES) || (m.rol_posse_antes !== m.rol_posse_depois && m.rol_posse_depois !== membresia_rol.COMUNGANTES));
    const itens = [...grupo].map(e => ({ evento_id: e.id, ordem_anterior: e.ordem_dia, ordem_nova: ordens.get(e.id)! })).sort((a, b) => a.evento_id.localeCompare(b.evento_id));
    const bloqueioOrgao = await impactoOrgaos(tx, igreja, pessoaId, data, true, { antes: eventos, depois: projetados }, coletar);
    const impacto = { alvo_tipo: porPessoa ? 'PESSOA' : 'OFICIAL', alvo_id: oficialId, oficial_id: porPessoa ? null : oficialId, pessoa_id: pessoaId, data_evento: proposta.data_evento, itens, mandatos: analise, conferencias: conferenciasImpacto, conferencia_alterada: conferenciaAlterada, inconsistencias_rol_origem: inconsistencias, bloqueada: invalida || conferenciaAlterada || inconsistencias.length > 0, ...(bloqueioOrgao ? { bloqueio_orgao: bloqueioOrgao } : {}), observacao: 'A sequência decorre da conferência declarada; o relatório compara apenas o rol e as origens registradas.' };
    const estado = { igreja, impacto, eventos: eventos.map(e => ({ ...e, data_evento: civil(e.data_evento), updated_at: e.updated_at.toISOString() })) };
    return { ...impacto, hash: createHash('sha256').update(JSON.stringify(estado)).digest('hex') };
  }
  /** Para ato isolado no dia, a sequência não altera o rol e pode ser conferida para qualquer pessoa. */
  async ordenarUnico(igreja: string, usuario: string, eventoId: string, dados: Unica, ator?: Ator) {
    const parsed = unicaSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Conferência inválida.');
    const v = { ...parsed.data, idempotencia: parsed.data.idempotencia.toLowerCase() };
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'registrar', ator);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':ordenacao:' + v.idempotencia}, 0))`;
      const anterior = await tx.ordenacao_membresia.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: v.idempotencia } } });
      if (anterior) {
        const impacto = anterior.impacto as Prisma.JsonObject;
        if (anterior.criado_por_id !== usuario || impacto.tipo !== 'ATO_ISOLADO' || impacto.evento_id !== eventoId || impacto.ordem_nova !== v.ordem || anterior.justificativa !== v.justificativa || anterior.autoridade !== v.autoridade || anterior.evidencia !== v.evidencia) throw new ConflictException('Chave de repetição já utilizada para outra conferência.');
        return anterior;
      }
      let evento = await tx.eventos_membresia.findFirst({ where: { id: eventoId, igreja_id: igreja }, select: { id: true, pessoa_id: true, data_evento: true, ordem_dia: true } });
      if (!evento) throw new NotFoundException('Evento não encontrado nesta igreja.');
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${evento.pessoa_id} AND igreja_id = ${igreja} FOR UPDATE`;
      evento = await tx.eventos_membresia.findFirst({ where: { id: eventoId, igreja_id: igreja }, select: { id: true, pessoa_id: true, data_evento: true, ordem_dia: true } });
      if (!evento) throw new NotFoundException('Evento não encontrado nesta igreja.');
      const quantidade = await tx.eventos_membresia.count({ where: { igreja_id: igreja, pessoa_id: evento.pessoa_id, data_evento: evento.data_evento } });
      if (quantidade !== 1 || evento.ordem_dia !== null) throw new ConflictException('O dia não possui exatamente um ato sem ordem; use a conferência completa.');
      if ((await impactoOrgaos(tx, igreja, evento.pessoa_id, evento.data_evento))?.bloqueia) throw new ConflictException('A alteração exige revisão dos vínculos de órgão.');
      const impacto = { tipo: 'ATO_ISOLADO', evento_id: eventoId, pessoa_id: evento.pessoa_id, data_evento: civil(evento.data_evento), ordem_anterior: null, ordem_nova: v.ordem, observacao: 'A ordem de um único ato não modifica o rol vigente.' };
      const registro = await tx.ordenacao_membresia.create({ data: { igreja_id: igreja, pessoa_id: evento.pessoa_id, data_evento: evento.data_evento, impacto, justificativa: v.justificativa, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia: v.idempotencia, criado_por_id: usuario } });
      await tx.item_ordenacao_membresia.create({ data: { ordenacao_id: registro.id, igreja_id: igreja, pessoa_id: evento.pessoa_id, evento_id: eventoId, ordem_anterior: null, ordem_nova: v.ordem } });
      await tx.$queryRaw`SELECT set_config('provisao.ordenacao_id', ${registro.id}, true)`;
      await tx.eventos_membresia.update({ where: { id: eventoId }, data: { ordem_dia: v.ordem } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'ordenacao_membresia', registro_id: registro.id, dados_novos: { evento_id: eventoId } } });
      return registro;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
  async listar(igreja: string, usuario: string, oficialId: string, porPessoa = false, ator?: Ator) {
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'consultar', ator);
      const pessoaId = await this.pessoaDoAlvo(tx, igreja, oficialId, porPessoa);
      const registros = await tx.ordenacao_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoaId }, select: { id: true, data_evento: true, impacto: true, justificativa: true, autoridade: true, evidencia: true, criado_em: true, criado_por: { select: { nome_usuario: true } } }, orderBy: [{ criado_em: 'desc' }, { id: 'asc' }] });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_ordenacao_membresia', registro_id: oficialId } });
      return registros;
    });
  }
  async previa(igreja: string, usuario: string, oficialId: string, dados: Proposta, porPessoa = false, ator?: Ator) {
    const parsed = propostaSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Sequência inválida.');
    return this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'consultar', ator); const resultado = await this.calcular(tx, igreja, oficialId, parsed.data, porPessoa); await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_ordenacao_membresia', registro_id: oficialId } }); return resultado; }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async aplicar(igreja: string, usuario: string, oficialId: string, dados: Aplicacao, porPessoa = false, ator?: Ator) {
    const parsed = aplicarSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Ordenação inválida.');
    const v = { ...parsed.data, idempotencia: parsed.data.idempotencia.toLowerCase() };
    return transacaoComRetentativa(this.prisma, async tx => {
      await this.autorizar(tx, igreja, usuario, 'registrar', ator);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':ordenacao:' + v.idempotencia}, 0))`;
      const antigo = await tx.ordenacao_membresia.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: v.idempotencia } } });
      if (antigo) {
        const impacto = antigo.impacto as Prisma.JsonObject;
        if (JSON.stringify(impacto.decisoes_orgao ?? null) !== JSON.stringify(v.decisoes_orgao ?? null)) throw new ConflictException('Chave já utilizada para outra revisão de órgãos.');
        const itensAnteriores = Array.isArray(impacto.itens) ? impacto.itens as Array<{ evento_id: string; ordem_nova: number }> : [];
        const ordemIgual = itensAnteriores.length === v.itens.length && v.itens.every(item => itensAnteriores.some(ant => ant.evento_id === item.evento_id && ant.ordem_nova === item.ordem));
        if (!ordemIgual || civil(antigo.data_evento) !== v.data_evento || antigo.criado_por_id !== usuario || (impacto.alvo_tipo ? impacto.alvo_tipo !== (porPessoa ? 'PESSOA' : 'OFICIAL') || impacto.alvo_id !== oficialId : porPessoa || impacto.oficial_id !== oficialId) || (impacto.decisao_id ?? null) !== (v.decisao_id ?? null) || impacto.hash !== v.hash_previa || antigo.justificativa !== v.justificativa || antigo.autoridade !== v.autoridade || antigo.evidencia !== v.evidencia) throw new ConflictException('Chave de repetição já utilizada para outra ordenação.');
        return antigo;
      }
      const pessoaId = await this.pessoaDoAlvo(tx, igreja, oficialId, porPessoa);
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${pessoaId} AND igreja_id = ${igreja} FOR UPDATE`;
      let detalhesOrgao: DetalheVinculoOrgao[] = [];
      const coletarOrgao = (itens: DetalheVinculoOrgao[]) => { detalhesOrgao = itens; };
      const previa = await this.calcular(tx, igreja, oficialId, { data_evento: v.data_evento, itens: v.itens }, porPessoa, coletarOrgao);
      if (previa.hash !== v.hash_previa) throw new ConflictException('Os dados mudaram; gere nova prévia antes de confirmar.');
      const revisaoOrgaos = await revisarOrgaosNaAplicacao(tx, igreja, usuario, previa.pessoa_id, 'ORDEM', previa, detalhesOrgao, v.decisoes_orgao);
      if (previa.inconsistencias_rol_origem.length) throw new ConflictException('A sequência exige revisão da origem de rol.');
      if (!previa.bloqueada && v.decisao_id) throw new BadRequestException('Esta prévia não exige decisão eleitoral.');
      if (previa.bloqueada) await consumirDecisaoEleitoral(tx, igreja, pessoaId, 'ORDEM', previa.hash, v.decisao_id, previa);
      const registro = await tx.ordenacao_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoaId, data_evento: new Date(`${v.data_evento}T00:00:00.000Z`), impacto: { ...previa, revisao_orgaos: revisaoOrgaos, decisoes_orgao: v.decisoes_orgao ?? null, decisao_id: v.decisao_id ?? null }, justificativa: v.justificativa, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia: v.idempotencia, criado_por_id: usuario } });
      await tx.item_ordenacao_membresia.createMany({ data: previa.itens.map(i => ({ ordenacao_id: registro.id, igreja_id: igreja, pessoa_id: pessoaId, evento_id: i.evento_id, ordem_anterior: i.ordem_anterior, ordem_nova: i.ordem_nova })) });
      await tx.$queryRaw`SELECT set_config('provisao.ordenacao_id', ${registro.id}, true)`;
      await tx.eventos_membresia.updateMany({ where: { id: { in: previa.itens.map(i => i.evento_id) }, igreja_id: igreja, pessoa_id: pessoaId }, data: { ordem_dia: null } });
      for (const item of previa.itens) await tx.eventos_membresia.update({ where: { id: item.evento_id }, data: { ordem_dia: item.ordem_nova } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'ordenacao_membresia', registro_id: registro.id, dados_novos: { hash: previa.hash } } });
      return registro;
    }, Prisma.TransactionIsolationLevel.Serializable, conflitoDeIdempotencia);
  }
}
