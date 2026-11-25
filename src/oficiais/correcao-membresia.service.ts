import type { Ator } from '../autorizacao/politica';
import { exigirServicoHistorico } from './autorizacao-historico';
import { revisarOrgaosNaAplicacao } from '../orgaos/revisao-aplicacao';
import { conflitoDeIdempotencia, transacaoComRetentativa } from '../orgaos/idempotencia';
import { consumirDecisaoEleitoral } from './consumir-decisao-eleitoral';
import { createHash } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, membresia_rol, Prisma } from '@prisma/client';
import { z } from 'zod';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { PrismaService } from '../prisma/prisma.service';
import { exigirAcessoSensivel } from './acesso-sensivel.service';
import { impactoOrgaos, DetalheVinculoOrgao } from './impacto-orgaos';
const dataCivil = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const propostaSchema = z.object({ evento_id: z.string().uuid(), nova_data: dataCivil }).strict();
const aplicarSchema = propostaSchema.extend({ hash_previa: z.string().regex(/^[a-f0-9]{64}$/), decisao_id: z.string().uuid().optional(), decisoes_orgao: z.array(z.uuid()).min(1).max(50).optional(), justificativa: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.string().uuid(), ciente: z.literal(true) }).strict();
type Proposta = z.infer<typeof propostaSchema>;
type Aplicacao = z.infer<typeof aplicarSchema>;
type Tx = Prisma.TransactionClient;
const civil = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class CorrecaoMembresiaService {
  constructor(private readonly prisma: PrismaService) {}
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
  /** Uso interno após autorização e bloqueio do alvo na transação chamadora. */
  async calcularParaOrgaos(tx: Tx, igreja: string, alvo: string, dados: unknown, porPessoa: boolean, coletar?: (detalhes: DetalheVinculoOrgao[]) => void) {
    const parsed = propostaSchema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Proposta inválida.');
    return this.calcular(tx, igreja, alvo, parsed.data, porPessoa, coletar);
  }
  private async calcular(tx: Tx, igreja: string, oficialId: string, proposta: Proposta, porPessoa = false, coletar?: (detalhes: DetalheVinculoOrgao[]) => void) {
    const pessoaId = await this.pessoaDoAlvo(tx, igreja, oficialId, porPessoa);
    const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoaId }, select: { id: true, data_evento: true, ordem_dia: true, tipo_evento: true, motivacao_evento: true, rol: true, rol_origem: true, updated_at: true }, orderBy: [{ data_evento: 'asc' }, { id: 'asc' }] });
    const indice = eventos.findIndex(e => e.id === proposta.evento_id);
    if (indice < 0) throw new NotFoundException('Evento não encontrado para esta pessoa e igreja.');
    const original = civil(eventos[indice].data_evento), nova = proposta.nova_data;
    if (original === nova) throw new BadRequestException('A data proposta deve ser diferente da atual.');
    const destino = eventos.filter(e => e.id !== proposta.evento_id && civil(e.data_evento) === nova);
    if (destino.length && (eventos[indice].ordem_dia == null || destino.some(e => e.ordem_dia == null || e.ordem_dia >= eventos[indice].ordem_dia!))) throw new BadRequestException('Na data de destino, a ordem existente do ato deve ser explícita e posterior às demais.');
    const projetados = eventos.map(e => ({ ...e, data_evento: e.id === proposta.evento_id ? new Date(`${nova}T00:00:00.000Z`) : e.data_evento }));
    const ordenar = (lista: typeof eventos) => {
      for (const d of new Set(lista.map(e => civil(e.data_evento)))) {
        const grupo = lista.filter(e => civil(e.data_evento) === d);
        if (grupo.length > 1 && (grupo.some(e => e.ordem_dia == null) || new Set(grupo.map(e => e.ordem_dia)).size !== grupo.length)) throw new BadRequestException('Confira a ordem dos atos que compartilham a mesma data antes da correção.');
      }
      return [...lista].sort((a, b) => a.data_evento.getTime() - b.data_evento.getTime() || (a.ordem_dia ?? 0) - (b.ordem_dia ?? 0));
    };
    const inconsistencias = (lista: typeof eventos) => {
      let anterior: membresia_rol | null = null;
      const ids: string[] = [];
      for (const e of ordenar(lista)) {
        if (e.tipo_evento === 'MUDANCA_DE_ROL' && (!anterior || e.rol_origem !== anterior)) ids.push(e.id);
        anterior = e.rol;
      }
      return ids;
    };
    const primeira = original < nova ? original : nova, ultima = original > nova ? original : nova;
    ordenar(eventos); // Não infere sequência de histórico preexistente ambíguo.
    const primeiraPosterior = projetados.map(e => civil(e.data_evento)).filter(d => d > ultima).sort()[0];
    const origemRelevante = new Set(projetados.filter(e => civil(e.data_evento) >= primeira && (civil(e.data_evento) <= ultima || civil(e.data_evento) === primeiraPosterior)).map(e => e.id));
    const origensInvalidadas = inconsistencias(projetados).filter(id => origemRelevante.has(id));
    const inicio = new Date(`${primeira}T00:00:00.000Z`);
    const [mandatos, conferencias] = await Promise.all([
      tx.mandato_oficial.findMany({ where: { igreja_id: igreja, oficial: { pessoa_id: pessoaId }, OR: [{ termino_efetivo: { gte: inicio } }, { termino_efetivo: null, termino_previsto: { gte: inicio } }] }, select: { id: true, oficial_id: true, data_eleicao: true, data_posse: true, termino_previsto: true, termino_efetivo: true }, orderBy: { id: 'asc' } }),
      tx.conferencia_eleicao_oficial.findMany({ where: { igreja_id: igreja, pessoa_id: pessoaId, data_eleicao: { gte: inicio } }, select: { id: true, data_eleicao: true }, orderBy: { id: 'asc' } }),
    ]);
    const rolEm = (dia: string, corrigido: boolean) => {
      const projetados = eventos.map(e => ({ ...e, data_evento: corrigido && e.id === proposta.evento_id ? new Date(`${nova}T00:00:00.000Z`) : e.data_evento }));
      const vigente = eventoVigente(projetados, new Date(`${dia}T00:00:00.000Z`));
      return vigente.situacao === 'DEFINIDO' ? vigente.evento.rol : 'INDETERMINADO';
    };
    const analise = mandatos.map(m => {
      const eleicao = civil(m.data_eleicao), posse = civil(m.data_posse);
      return { id: m.id, oficial_id: m.oficial_id, eleicao, posse, termino: civil(m.termino_efetivo ?? m.termino_previsto), rol_eleicao_antes: rolEm(eleicao, false), rol_eleicao_depois: rolEm(eleicao, true), rol_posse_antes: rolEm(posse, false), rol_posse_depois: rolEm(posse, true) };
    });
    const eventoEm = (dia: string, corrigido: boolean) => {
      const projetados = eventos.map(e => ({ ...e, data_evento: corrigido && e.id === proposta.evento_id ? new Date(`${nova}T00:00:00.000Z`) : e.data_evento }));
      const resultado = eventoVigente(projetados, new Date(`${dia}T00:00:00.000Z`));
      return resultado.situacao === 'DEFINIDO' ? resultado.evento.id : resultado.situacao;
    };
    const conferenciaAlterada = conferencias.some(c => eventoEm(civil(c.data_eleicao), false) !== eventoEm(civil(c.data_eleicao), true));
    const invalida = analise.some(m => (m.rol_eleicao_antes !== m.rol_eleicao_depois && m.rol_eleicao_depois !== membresia_rol.COMUNGANTES) || (m.rol_posse_antes !== m.rol_posse_depois && m.rol_posse_depois !== membresia_rol.COMUNGANTES));
    const bloqueioOrgao = await impactoOrgaos(tx, igreja, pessoaId, inicio, true, { antes: eventos, depois: projetados }, coletar);
    const impacto = { alvo_tipo: porPessoa ? 'PESSOA' : 'OFICIAL', alvo_id: oficialId, oficial_id: porPessoa ? null : oficialId, evento_id: proposta.evento_id, pessoa_id: pessoaId, data_anterior: original, data_nova: nova, intervalo_afetado: { inicio: primeira, fim: ultima }, mandatos: analise, conferencias: conferencias.map(c => ({ id: c.id, data_eleicao: civil(c.data_eleicao), rol_antes: rolEm(civil(c.data_eleicao), false), rol_depois: rolEm(civil(c.data_eleicao), true), evento_antes: eventoEm(civil(c.data_eleicao), false), evento_depois: eventoEm(civil(c.data_eleicao), true) })), conferencia_alterada: conferenciaAlterada, origens_invalidadas: origensInvalidadas, bloqueada: invalida || conferenciaAlterada || origensInvalidadas.length > 0, ...(bloqueioOrgao ? { bloqueio_orgao: bloqueioOrgao } : {}), observacao: 'A análise compara o rol; não reavalia todos os requisitos institucionais nem altera atos passados.' };
    const estado = { igreja, oficial_id: oficialId, impacto, eventos: eventos.map(e => ({ ...e, data_evento: civil(e.data_evento), updated_at: e.updated_at.toISOString() })) };
    const hash = createHash('sha256').update(JSON.stringify(estado)).digest('hex');
    return { ...impacto, hash };
  }
  async listarCorrecoes(igreja: string, usuario: string, oficialId: string, porPessoa = false, ator?: Ator) {
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'consultar', ator);
      const pessoaId = await this.pessoaDoAlvo(tx, igreja, oficialId, porPessoa);
      const registros = await tx.correcao_data_membresia.findMany({ where: { igreja_id: igreja, evento: { pessoa_id: pessoaId } }, select: { id: true, evento_id: true, data_anterior: true, data_nova: true, impacto: true, justificativa: true, autoridade: true, evidencia: true, criado_em: true, criado_por: { select: { nome_usuario: true } } }, orderBy: [{ criado_em: 'desc' }, { id: 'asc' }] });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_correcao_membresia', registro_id: oficialId } });
      return registros;
    });
  }
  async listarEventos(igreja: string, usuario: string, oficialId: string, ator?: Ator) {
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'consultar', ator);
      const pessoaId = await this.pessoaDoAlvo(tx, igreja, oficialId, false);
      const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoaId }, select: { id: true, tipo_evento: true, data_evento: true, ordem_dia: true, rol: true }, orderBy: [{ data_evento: 'asc' }, { id: 'asc' }] });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_correcao_membresia', registro_id: oficialId } });
      return eventos;
    });
  }
  async previa(igreja: string, usuario: string, oficialId: string, dados: Proposta, porPessoa = false, ator?: Ator) {
    const parsed = propostaSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Proposta inválida.');
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'consultar', ator);
      const resultado = await this.calcular(tx, igreja, oficialId, parsed.data, porPessoa);
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_correcao_membresia', registro_id: parsed.data.evento_id } });
      return resultado;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async aplicar(igreja: string, usuario: string, oficialId: string, dados: Aplicacao, porPessoa = false, ator?: Ator) {
    const parsed = aplicarSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Correção inválida.');
    const v = { ...parsed.data, idempotencia: parsed.data.idempotencia.toLowerCase() };
    return transacaoComRetentativa(this.prisma, async tx => {
      await this.autorizar(tx, igreja, usuario, 'registrar', ator);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':correcao:' + v.idempotencia}, 0))`;
      const anterior = await tx.correcao_data_membresia.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: v.idempotencia } } });
      if (anterior) {
        const impacto = anterior.impacto as Prisma.JsonObject;
        if (JSON.stringify(impacto.decisoes_orgao ?? null) !== JSON.stringify(v.decisoes_orgao ?? null)) throw new ConflictException('Chave já utilizada para outra revisão de órgãos.');
        if (anterior.criado_por_id !== usuario || (impacto.alvo_tipo ? impacto.alvo_tipo !== (porPessoa ? 'PESSOA' : 'OFICIAL') || impacto.alvo_id !== oficialId : porPessoa || impacto.oficial_id !== oficialId) || anterior.evento_id !== v.evento_id || civil(anterior.data_nova) !== v.nova_data || (impacto.decisao_id ?? null) !== (v.decisao_id ?? null) || impacto.hash !== v.hash_previa || anterior.justificativa !== v.justificativa || anterior.autoridade !== v.autoridade || anterior.evidencia !== v.evidencia) throw new ConflictException('Chave de repetição já utilizada para outra correção.');
        return anterior;
      }
      const alvo = await tx.eventos_membresia.findFirst({ where: { id: v.evento_id, igreja_id: igreja }, select: { pessoa_id: true } });
      if (!alvo) throw new NotFoundException('Evento não encontrado nesta igreja.');
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${alvo.pessoa_id} AND igreja_id = ${igreja} FOR UPDATE`;
      let detalhesOrgao: DetalheVinculoOrgao[] = [];
      const coletarOrgao = (itens: DetalheVinculoOrgao[]) => { detalhesOrgao = itens; };
      const previa = await this.calcular(tx, igreja, oficialId, { evento_id: v.evento_id, nova_data: v.nova_data }, porPessoa, coletarOrgao);
      if (previa.hash !== v.hash_previa) throw new ConflictException('Os dados mudaram; gere nova prévia antes de confirmar.');
      const revisaoOrgaos = await revisarOrgaosNaAplicacao(tx, igreja, usuario, previa.pessoa_id, 'DATA', previa, detalhesOrgao, v.decisoes_orgao);
      if (previa.origens_invalidadas.length) throw new ConflictException('A alteração exige revisão da origem de rol.');
      if (!previa.bloqueada && v.decisao_id) throw new BadRequestException('Esta prévia não exige decisão eleitoral.');
      if (previa.bloqueada) await consumirDecisaoEleitoral(tx, igreja, previa.pessoa_id, 'DATA', previa.hash, v.decisao_id, previa);
      const correcao = await tx.correcao_data_membresia.create({ data: { igreja_id: igreja, evento_id: v.evento_id, data_anterior: new Date(`${previa.data_anterior}T00:00:00.000Z`), data_nova: new Date(`${v.nova_data}T00:00:00.000Z`), impacto: { ...previa, revisao_orgaos: revisaoOrgaos, decisoes_orgao: v.decisoes_orgao ?? null, decisao_id: v.decisao_id ?? null }, justificativa: v.justificativa, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia: v.idempotencia, criado_por_id: usuario } });
      await tx.$queryRaw`SELECT set_config('provisao.correcao_id', ${correcao.id}, true), set_config('provisao.correcao_evento', ${v.evento_id}, true), set_config('provisao.correcao_data', ${v.nova_data}, true)`;
      await tx.eventos_membresia.update({ where: { id: v.evento_id }, data: { data_evento: new Date(`${v.nova_data}T00:00:00.000Z`) } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'correcao_data_membresia', registro_id: correcao.id, dados_novos: { evento_id: v.evento_id, hash: previa.hash } } });
      return correcao;
    }, Prisma.TransactionIsolationLevel.Serializable, conflitoDeIdempotencia);
  }
}
