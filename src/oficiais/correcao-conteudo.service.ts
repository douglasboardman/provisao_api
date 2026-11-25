import type { Ator } from '../autorizacao/politica';
import { exigirServicoHistorico } from './autorizacao-historico';
import { bloquearRegrasMembresia, consultarRegrasDaIgreja } from '../regras-relacao-enum/parametros-membresia';
import { revisarOrgaosNaAplicacao } from '../orgaos/revisao-aplicacao';
import { conflitoDeIdempotencia, transacaoComRetentativa } from '../orgaos/idempotencia';
import { consumirDecisaoEleitoral } from './consumir-decisao-eleitoral';
import { createHash } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, membresia_motivacao_evento, membresia_rol, membresia_tipo_evento, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { exigirAcessoSensivel } from './acesso-sensivel.service';
import { impactoOrgaos, DetalheVinculoOrgao } from './impacto-orgaos';
const propostaSchema = z.object({ evento_id: z.string().uuid(), tipo_evento: z.nativeEnum(membresia_tipo_evento), rol: z.nativeEnum(membresia_rol), motivacao_evento: z.nativeEnum(membresia_motivacao_evento) }).strict();
const aplicarSchema = propostaSchema.extend({ hash_previa: z.string().regex(/^[a-f0-9]{64}$/), decisao_id: z.string().uuid().optional(), decisoes_orgao: z.array(z.uuid()).min(1).max(50).optional(), justificativa: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.string().uuid(), ciente: z.literal(true) }).strict();
type Proposta = z.infer<typeof propostaSchema>; type Aplicacao = z.infer<typeof aplicarSchema>; type Tx = Prisma.TransactionClient;
const civil = (d: Date) => d.toISOString().slice(0, 10);
@Injectable()
export class CorrecaoConteudoService {
  constructor(private readonly prisma: PrismaService) {}
  /** Uso interno após autorização e bloqueio do alvo na transação chamadora. */
  async calcularParaOrgaos(tx: Tx, igreja: string, pessoa: string, dados: unknown, coletar?: (detalhes: DetalheVinculoOrgao[]) => void) {
    const parsed = propostaSchema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Proposta inválida.');
    return this.calcular(tx, igreja, pessoa, parsed.data, coletar);
  }
  private async autorizar(tx: Tx, igreja: string, usuario: string, modo: 'consultar' | 'registrar', ator?: Ator) {
    const escrita = modo === 'registrar';
    await exigirServicoHistorico(tx, igreja, usuario, escrita ? 'HISTORICO_MEMBRESIA_RETIFICAR' : 'HISTORICO_MEMBRESIA_CONSULTAR', escrita, ator);
    await exigirAcessoSensivel(tx, igreja, usuario, modo);
  }
  private async calcular(tx: Tx, igreja: string, pessoa: string, proposta: Proposta, coletar?: (detalhes: DetalheVinculoOrgao[]) => void) {
    if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
    const regras = await consultarRegrasDaIgreja(tx, igreja);
    const permite = (nome: string, origem: string, destino: string) => regras.some(r => r.nome === nome && r.valores.some(v => v.valor_classificador === origem && v.valor_classificado === destino));
    const rotulos = { ADMISSAO: 'Admissão', DEMISSAO: 'Demissão', MUDANCA_DE_ROL: 'Mudança de Rol' };
    if (!permite(`Motivações de ${rotulos[proposta.tipo_evento]}`, proposta.tipo_evento, proposta.motivacao_evento)) throw new BadRequestException('Motivação inválida para o tipo de evento.');
    if (proposta.tipo_evento === 'DEMISSAO') {
      const destinos = regras.filter(r => r.nome === 'Rol de Destino por Motivação de Demissão').flatMap(r => r.valores.filter(v => v.valor_classificador === proposta.motivacao_evento).map(v => v.valor_classificado));
      if (destinos.length !== 1 || destinos[0] !== proposta.rol) throw new BadRequestException('Rol incompatível ou mapeamento de demissão ambíguo.');
    }
    if (proposta.tipo_evento === 'ADMISSAO' && !permite('Rols de Admissão', proposta.tipo_evento, proposta.rol)) throw new BadRequestException('Rol inválido para admissão.');
    if (proposta.tipo_evento === 'MUDANCA_DE_ROL' && (!permite('Rols de Mudança de Rol', proposta.tipo_evento, proposta.rol) || !permite('Motivações por Rol de Destino', proposta.rol, proposta.motivacao_evento))) throw new BadRequestException('Rol ou motivação inválida para mudança de rol.');
    const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa }, select: { id: true, data_evento: true, ordem_dia: true, tipo_evento: true, motivacao_evento: true, rol: true, rol_origem: true, updated_at: true }, orderBy: [{ data_evento: 'asc' }, { id: 'asc' }] });
    const atual = eventos.find(e => e.id === proposta.evento_id); if (!atual) throw new NotFoundException('Evento não encontrado para esta pessoa e igreja.');
    const grupo = eventos.filter(e => e.data_evento.getTime() === atual.data_evento.getTime());
    if (grupo.length > 1 && (grupo.some(e => e.ordem_dia == null) || new Set(grupo.map(e => e.ordem_dia)).size !== grupo.length)) throw new BadRequestException('Confira primeiro a ordem dos atos da data.');
    const antesLista = eventos.filter(e => e.data_evento < atual.data_evento || (e.data_evento.getTime() === atual.data_evento.getTime() && grupo.length > 1 && e.ordem_dia! < atual.ordem_dia!));
    const antes = eventoVigente(antesLista, atual.data_evento);
    if (antes.situacao === 'AMBIGUO') throw new BadRequestException('Confira a ordem dos atos anteriores.');
    const origem = proposta.tipo_evento === 'MUDANCA_DE_ROL' && antes.situacao === 'DEFINIDO' ? antes.evento.rol : null;
    if (proposta.tipo_evento === 'MUDANCA_DE_ROL' && origem === null) throw new BadRequestException('Mudança de rol exige rol anterior conhecido.');
    const dados_anteriores = { tipo_evento: atual.tipo_evento, rol: atual.rol, rol_origem: atual.rol_origem, motivacao_evento: atual.motivacao_evento };
    const dados_novos = { tipo_evento: proposta.tipo_evento, rol: proposta.rol, rol_origem: origem, motivacao_evento: proposta.motivacao_evento };
    if (Object.entries(dados_novos).every(([k, v]) => dados_anteriores[k as keyof typeof dados_anteriores] === v)) throw new BadRequestException('A proposta não altera o evento.');
    const posteriores = eventos.filter(e => e.data_evento > atual.data_evento || (e.data_evento.getTime() === atual.data_evento.getTime() && grupo.length > 1 && e.ordem_dia! > atual.ordem_dia!));
    const seguinteData = posteriores.reduce((m, e) => Math.min(m, e.data_evento.getTime()), Infinity);
    const seguintes = posteriores.filter(e => e.data_evento.getTime() === seguinteData);
    if (seguintes.length > 1 && (seguintes.some(e => e.ordem_dia == null) || new Set(seguintes.map(e => e.ordem_dia)).size !== seguintes.length)) throw new BadRequestException('Confira a ordem dos atos seguintes.');
    const seguinte = [...seguintes].sort((a, b) => (a.ordem_dia ?? 0) - (b.ordem_dia ?? 0))[0];
    const origemInvalida = !!seguinte && seguinte.tipo_evento === 'MUDANCA_DE_ROL' && seguinte.rol_origem !== proposta.rol;
    const projetados = eventos.map(e => e.id === atual.id ? { ...e, ...dados_novos } : e);
    const [mandatos, conferencias] = await Promise.all([
      tx.mandato_oficial.findMany({ where: { igreja_id: igreja, oficial: { pessoa_id: pessoa }, data_posse: { gte: atual.data_evento } }, select: { id: true, data_eleicao: true, data_posse: true }, orderBy: { id: 'asc' } }),
      tx.conferencia_eleicao_oficial.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, data_eleicao: { gte: atual.data_evento } }, select: { id: true, data_eleicao: true }, orderBy: { id: 'asc' } }),
    ]);
    const vigente = (lista: typeof eventos, d: Date) => eventoVigente(lista, d);
    const rolEm = (lista: typeof eventos, d: Date) => { const v = vigente(lista, d); return v.situacao === 'DEFINIDO' ? v.evento.rol : 'INDETERMINADO'; };
    const analise = mandatos.map(m => ({ id: m.id, eleicao: civil(m.data_eleicao), posse: civil(m.data_posse), rol_eleicao_antes: rolEm(eventos, m.data_eleicao), rol_eleicao_depois: rolEm(projetados, m.data_eleicao), rol_posse_antes: rolEm(eventos, m.data_posse), rol_posse_depois: rolEm(projetados, m.data_posse) }));
    const conferenciasImpacto = conferencias.map(c => { const v = vigente(eventos, c.data_eleicao); return { id: c.id, data_eleicao: civil(c.data_eleicao), evento_corrigido_utilizado: v.situacao === 'DEFINIDO' && v.evento.id === atual.id, rol_antes: rolEm(eventos, c.data_eleicao), rol_depois: rolEm(projetados, c.data_eleicao) }; });
    const invalida = analise.some(m => (m.rol_eleicao_antes !== m.rol_eleicao_depois && m.rol_eleicao_depois !== 'COMUNGANTES') || (m.rol_posse_antes !== m.rol_posse_depois && m.rol_posse_depois !== 'COMUNGANTES'));
    const bloqueioOrgao = await impactoOrgaos(tx, igreja, pessoa, atual.data_evento, dados_anteriores.rol !== dados_novos.rol, { antes: eventos, depois: projetados }, coletar);
    const impacto = { pessoa_id: pessoa, evento_id: atual.id, data_evento: civil(atual.data_evento), dados_anteriores, dados_novos, mandatos: analise, conferencias: conferenciasImpacto, origem_seguinte_invalida: origemInvalida, bloqueada: invalida || origemInvalida || conferenciasImpacto.some(c => c.evento_corrigido_utilizado), ...(bloqueioOrgao ? { bloqueio_orgao: bloqueioOrgao } : {}), observacao: 'A prévia compara rol e origem; não reavalia todos os requisitos institucionais.' };
    const estado = { igreja, impacto, eventos: eventos.map(e => ({ ...e, data_evento: civil(e.data_evento), updated_at: e.updated_at.toISOString() })), regras: regras.map(r => ({ id: r.id, updated_at: r.updated_at, valores: r.valores.map(v => [v.valor_classificador, v.valor_classificado]).sort() })) };
    return { ...impacto, hash: createHash('sha256').update(JSON.stringify(estado)).digest('hex') };
  }
  async previa(igreja: string, usuario: string, pessoa: string, dados: Proposta, ator?: Ator) {
    const p = propostaSchema.safeParse(dados); if (!p.success) throw new BadRequestException('Proposta inválida.');
    return this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'consultar', ator); const r = await this.calcular(tx, igreja, pessoa, p.data); await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_correcao_conteudo', registro_id: pessoa } }); return r; }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async listar(igreja: string, usuario: string, pessoa: string, ator?: Ator) {
    return this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'consultar', ator); if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.'); const r = await tx.correcao_conteudo_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa }, select: { id: true, evento_id: true, dados_anteriores: true, dados_novos: true, impacto: true, justificativa: true, autoridade: true, evidencia: true, criado_em: true, criado_por: { select: { nome_usuario: true } } }, orderBy: { criado_em: 'desc' } }); await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_correcao_conteudo', registro_id: pessoa } }); return r; });
  }
  async aplicar(igreja: string, usuario: string, pessoa: string, dados: Aplicacao, ator?: Ator) {
    const parsed = aplicarSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Correção inválida.');
    const { hash_previa, decisao_id, decisoes_orgao, justificativa, autoridade, evidencia, idempotencia, ciente: _ciente, ...proposta } = parsed.data, chave = idempotencia.toLowerCase();
    return transacaoComRetentativa(this.prisma, async tx => {
      await this.autorizar(tx, igreja, usuario, 'registrar', ator);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':conteudo:' + chave}, 0))`;
      const anterior = await tx.correcao_conteudo_membresia.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: chave } } });
      if (anterior) {
        const impacto = anterior.impacto as Prisma.JsonObject;
        if (JSON.stringify(impacto.decisoes_orgao ?? null) !== JSON.stringify(decisoes_orgao ?? null)) throw new ConflictException('Chave já utilizada para outra revisão de órgãos.');
        if (anterior.pessoa_id !== pessoa || anterior.criado_por_id !== usuario || (impacto.decisao_id ?? null) !== (decisao_id ?? null) || impacto.hash !== hash_previa || !impacto.proposta || typeof impacto.proposta !== 'object' || Object.entries(proposta).some(([k, v]) => (impacto.proposta as Prisma.JsonObject)[k] !== v) || anterior.justificativa !== justificativa || anterior.autoridade !== autoridade || anterior.evidencia !== evidencia) throw new ConflictException('Chave já utilizada para outra correção.');
        return anterior;
      }
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${pessoa} AND igreja_id = ${igreja} FOR UPDATE`;
      await bloquearRegrasMembresia(tx, igreja);
      let detalhesOrgao: DetalheVinculoOrgao[] = [];
      const coletarOrgao = (itens: DetalheVinculoOrgao[]) => { detalhesOrgao = itens; };
      const previa = await this.calcular(tx, igreja, pessoa, proposta, coletarOrgao);
      if (previa.hash !== hash_previa) throw new ConflictException('Os dados mudaram; gere nova prévia antes de confirmar.');
      const revisaoOrgaos = await revisarOrgaosNaAplicacao(tx, igreja, usuario, pessoa, 'CONTEUDO', previa, detalhesOrgao, decisoes_orgao);
      if (previa.origem_seguinte_invalida) throw new ConflictException('A correção exige revisão da origem de rol.');
      if (!previa.bloqueada && decisao_id) throw new BadRequestException('Esta prévia não exige decisão eleitoral.');
      if (previa.bloqueada) await consumirDecisaoEleitoral(tx, igreja, pessoa, 'CONTEUDO', previa.hash, decisao_id, previa);
      const registro = await tx.correcao_conteudo_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, evento_id: proposta.evento_id, dados_anteriores: previa.dados_anteriores, dados_novos: previa.dados_novos, impacto: { ...previa, revisao_orgaos: revisaoOrgaos, decisoes_orgao: decisoes_orgao ?? null, proposta, decisao_id: decisao_id ?? null }, justificativa, autoridade, evidencia, idempotencia: chave, criado_por_id: usuario } });
      await tx.$queryRaw`SELECT set_config('provisao.correcao_conteudo_id', ${registro.id}, true)`;
      await tx.eventos_membresia.update({ where: { id: proposta.evento_id }, data: previa.dados_novos });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'correcao_conteudo_membresia', registro_id: registro.id } });
      return registro;
    }, Prisma.TransactionIsolationLevel.Serializable, conflitoDeIdempotencia);
  }
}
