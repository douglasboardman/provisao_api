import { bloquearRegrasMembresia, consultarRegrasDaIgreja } from '../regras-relacao-enum/parametros-membresia';
import { revisarOrgaosNaAplicacao } from '../orgaos/revisao-aplicacao';
import { transacaoSerializavel } from '../orgaos/idempotencia';
import { consumirDecisaoEleitoral } from './consumir-decisao-eleitoral';
import { createHash, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, membresia_motivacao_evento, membresia_rol, membresia_tipo_evento, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { exigirAcessoSensivel } from './acesso-sensivel.service';
import { impactoOrgaos, DetalheVinculoOrgao } from './impacto-orgaos';

const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const propostaSchema = z.object({ data_evento: dia, ordem_dia: z.number().int().min(1).max(9999).nullable().optional(), tipo_evento: z.nativeEnum(membresia_tipo_evento), rol: z.nativeEnum(membresia_rol), motivacao_evento: z.nativeEnum(membresia_motivacao_evento), igreja_origem: z.string().trim().max(255).nullable(), igreja_destino: z.string().trim().max(255).nullable(), observacoes: z.string().trim().max(1000).nullable() }).strict();
const aplicarSchema = propostaSchema.extend({ hash_previa: z.string().regex(/^[a-f0-9]{64}$/), decisao_id: z.string().uuid().optional(), decisoes_orgao: z.array(z.uuid()).min(1).max(50).optional(), justificativa: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.string().uuid(), ciente: z.literal(true) }).strict();
type Proposta = z.infer<typeof propostaSchema>; type Aplicacao = z.infer<typeof aplicarSchema>; type Tx = Prisma.TransactionClient;
const civil = (d: Date) => d.toISOString().slice(0, 10);
@Injectable()
export class InsercaoRetroativaService {
  constructor(private readonly prisma: PrismaService) {}
  /** Uso interno após autorização e bloqueio do alvo na transação chamadora. */
  async calcularParaOrgaos(tx: Tx, igreja: string, pessoa: string, dados: unknown, coletar?: (detalhes: DetalheVinculoOrgao[]) => void) {
    const parsed = propostaSchema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Proposta inválida.');
    return this.calcular(tx, igreja, pessoa, parsed.data, coletar);
  }
  private async autorizar(tx: Tx, igreja: string, usuario: string, modo: 'consultar' | 'registrar') {
    const perfis: usuarios_perfil[] = [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR, usuarios_perfil.SECRETARIO];
    if (modo === 'consultar') perfis.push(usuarios_perfil.AUDITOR);
    if (!await tx.usuarios.findFirst({ where: { id: usuario, igreja_id: igreja, ativo: true, perfil: { in: perfis } }, select: { id: true } })) throw new ForbiddenException('Operador não autorizado nesta igreja.');
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
    const data = new Date(`${proposta.data_evento}T00:00:00.000Z`);
    const ordem = proposta.ordem_dia ?? null;
    const mesmoDia = eventos.filter(e => e.data_evento.getTime() === data.getTime());
    if (mesmoDia.length && (ordem === null || mesmoDia.some(e => e.ordem_dia === null))) throw new BadRequestException('Confira a ordem de todos os atos existentes e informe a ordem do novo ato.');
    if (mesmoDia.some(e => e.ordem_dia === ordem) || new Set(mesmoDia.map(e => e.ordem_dia)).size !== mesmoDia.length) throw new BadRequestException('As ordens dos atos no mesmo dia devem ser distintas.');
    const anteriores = eventos.filter(e => e.data_evento < data || (e.data_evento.getTime() === data.getTime() && e.ordem_dia! < ordem!));
    const posteriores = eventos.filter(e => e.data_evento > data || (e.data_evento.getTime() === data.getTime() && e.ordem_dia! > ordem!));
    if (!posteriores.length) throw new BadRequestException('Use a inclusão comum para evento posterior ao histórico.');
    const antes = eventoVigente(anteriores, data);
    if (antes.situacao === 'AMBIGUO') throw new BadRequestException('Confira a ordem dos atos anteriores antes de incluir este evento.');
    const origem = antes.situacao === 'DEFINIDO' ? antes.evento.rol : null;
    if (proposta.tipo_evento === 'MUDANCA_DE_ROL' && origem === null) throw new BadRequestException('Mudança de rol exige rol anterior conhecido.');
    const seguinteData = posteriores.reduce((m, e) => Math.min(m, e.data_evento.getTime()), Infinity);
    const seguintes = posteriores.filter(e => e.data_evento.getTime() === seguinteData);
    if (seguintes.length > 1 && (seguintes.some(e => e.ordem_dia == null) || new Set(seguintes.map(e => e.ordem_dia)).size !== seguintes.length)) throw new BadRequestException('Confira a ordem dos atos seguintes antes de incluir este evento.');
    const seguinte = [...seguintes].sort((a, b) => (a.ordem_dia ?? 0) - (b.ordem_dia ?? 0))[0];
    const origemInvalida = seguinte.tipo_evento === 'MUDANCA_DE_ROL' && seguinte.rol_origem !== proposta.rol;
    const novo = { id: 'projetado', data_evento: data, ordem_dia: ordem, tipo_evento: proposta.tipo_evento, motivacao_evento: proposta.motivacao_evento, rol: proposta.rol, rol_origem: proposta.tipo_evento === 'MUDANCA_DE_ROL' ? origem : null, updated_at: new Date(0) };
    const projetados = [...eventos, novo];
    const [mandatos, conferencias] = await Promise.all([
      tx.mandato_oficial.findMany({ where: { igreja_id: igreja, oficial: { pessoa_id: pessoa }, data_posse: { gte: data } }, select: { id: true, data_eleicao: true, data_posse: true }, orderBy: { id: 'asc' } }),
      tx.conferencia_eleicao_oficial.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, data_eleicao: { gte: data } }, select: { id: true, data_eleicao: true }, orderBy: { id: 'asc' } }),
    ]);
    const rolEm = (lista: typeof eventos, d: Date) => { const e = eventoVigente(lista, d); return e.situacao === 'DEFINIDO' ? e.evento.rol : 'INDETERMINADO'; };
    const analise = mandatos.map(m => ({ id: m.id, eleicao: civil(m.data_eleicao), posse: civil(m.data_posse), rol_eleicao_antes: rolEm(eventos, m.data_eleicao), rol_eleicao_depois: rolEm(projetados, m.data_eleicao), rol_posse_antes: rolEm(eventos, m.data_posse), rol_posse_depois: rolEm(projetados, m.data_posse) }));
    // Conferências preservam o identificador do evento usado, mesmo quando o rol não muda.
    const eventoEm = (lista: typeof eventos, d: Date) => { const e = eventoVigente(lista, d); return e.situacao === 'DEFINIDO' ? e.evento.id : e.situacao; };
    const conferenciasImpacto = conferencias.map(c => ({ id: c.id, data_eleicao: civil(c.data_eleicao), rol_antes: rolEm(eventos, c.data_eleicao), rol_depois: rolEm(projetados, c.data_eleicao), evento_antes: eventoEm(eventos, c.data_eleicao), evento_depois: eventoEm(projetados, c.data_eleicao) }));
    const conferenciaAlterada = conferencias.some(c => eventoEm(eventos, c.data_eleicao) !== eventoEm(projetados, c.data_eleicao));
    const invalida = analise.some(m => (m.rol_eleicao_antes !== m.rol_eleicao_depois && m.rol_eleicao_depois !== 'COMUNGANTES') || (m.rol_posse_antes !== m.rol_posse_depois && m.rol_posse_depois !== 'COMUNGANTES'));
    const dados_evento = { tipo_evento: proposta.tipo_evento, rol: proposta.rol, rol_origem: novo.rol_origem, motivacao_evento: proposta.motivacao_evento, ordem_dia: ordem, igreja_origem: proposta.igreja_origem, igreja_destino: proposta.igreja_destino, observacoes: proposta.observacoes };
    const bloqueioOrgao = await impactoOrgaos(tx, igreja, pessoa, data, true, { antes: eventos, depois: projetados }, coletar);
    const impacto = { pessoa_id: pessoa, data_evento: proposta.data_evento, dados_evento, mandatos: analise, conferencias: conferenciasImpacto, origem_seguinte_invalida: origemInvalida, conferencia_alterada: conferenciaAlterada, bloqueada: invalida || origemInvalida || conferenciaAlterada, ...(bloqueioOrgao ? { bloqueio_orgao: bloqueioOrgao } : {}), observacao: 'A prévia compara rol e origem; não reavalia todos os requisitos institucionais.' };
    const estado = { igreja, impacto, eventos: eventos.map(e => ({ ...e, data_evento: civil(e.data_evento), updated_at: e.updated_at.toISOString() })), regras: regras.map(r => ({ id: r.id, updated_at: r.updated_at, valores: r.valores.map(v => [v.valor_classificador, v.valor_classificado]).sort() })) };
    return { ...impacto, hash: createHash('sha256').update(JSON.stringify(estado)).digest('hex') };
  }
  async previa(igreja: string, usuario: string, pessoa: string, dados: Proposta) {
    const p = propostaSchema.safeParse(dados); if (!p.success) throw new BadRequestException('Proposta inválida.');
    return this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'consultar'); const r = await this.calcular(tx, igreja, pessoa, p.data); await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_insercao_retroativa', registro_id: pessoa } }); return r; }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async listar(igreja: string, usuario: string, pessoa: string) {
    return this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'consultar'); if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.'); const r = await tx.insercao_retroativa_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa }, select: { id: true, evento_id: true, data_evento: true, impacto: true, justificativa: true, autoridade: true, evidencia: true, criado_em: true, criado_por: { select: { nome_usuario: true } } }, orderBy: { criado_em: 'desc' } }); await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_insercao_retroativa', registro_id: pessoa } }); return r; });
  }
  async aplicar(igreja: string, usuario: string, pessoa: string, dados: Aplicacao) {
    const parsed = aplicarSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Inclusão inválida.');
    const { hash_previa, decisao_id, decisoes_orgao, justificativa, autoridade, evidencia, idempotencia, ciente: _ciente, ...proposta } = parsed.data;
    const chave = idempotencia.toLowerCase();
    return transacaoSerializavel(this.prisma, async tx => {
      await this.autorizar(tx, igreja, usuario, 'registrar');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':insercao:' + chave}, 0))`;
      const anterior = await tx.insercao_retroativa_membresia.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: chave } } });
      if (anterior) {
        const impacto = anterior.impacto as Prisma.JsonObject;
        if (JSON.stringify(impacto.decisoes_orgao ?? null) !== JSON.stringify(decisoes_orgao ?? null)) throw new ConflictException('Chave já utilizada para outra revisão de órgãos.');
        if (anterior.pessoa_id !== pessoa || anterior.criado_por_id !== usuario || (impacto.decisao_id ?? null) !== (decisao_id ?? null) || impacto.hash !== hash_previa || !impacto.proposta || typeof impacto.proposta !== 'object' || Object.entries({ ...proposta, ordem_dia: proposta.ordem_dia ?? null }).some(([k, v]) => (k === 'ordem_dia' ? (impacto.proposta as Prisma.JsonObject)[k] ?? null : (impacto.proposta as Prisma.JsonObject)[k]) !== (k === 'ordem_dia' ? v ?? null : v)) || anterior.justificativa !== justificativa || anterior.autoridade !== autoridade || anterior.evidencia !== evidencia) throw new ConflictException('Chave já utilizada para outra inclusão.');
        return anterior;
      }
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${pessoa} AND igreja_id = ${igreja} FOR UPDATE`;
      // Bloqueia alterações das regras e seus valores enquanto valida e registra o ato.
      await bloquearRegrasMembresia(tx, igreja);
      let detalhesOrgao: DetalheVinculoOrgao[] = [];
      const coletarOrgao = (itens: DetalheVinculoOrgao[]) => { detalhesOrgao = itens; };
      const previa = await this.calcular(tx, igreja, pessoa, proposta, coletarOrgao);
      if (previa.hash !== hash_previa) throw new ConflictException('Os dados mudaram; gere nova prévia antes de confirmar.');
      const revisaoOrgaos = await revisarOrgaosNaAplicacao(tx, igreja, usuario, pessoa, 'INSERCAO', previa, detalhesOrgao, decisoes_orgao);
      if (previa.origem_seguinte_invalida) throw new ConflictException('A inclusão exige revisão da origem de rol.');
      if (!previa.bloqueada && decisao_id) throw new BadRequestException('Esta prévia não exige decisão eleitoral.');
      if (previa.bloqueada) await consumirDecisaoEleitoral(tx, igreja, pessoa, 'INSERCAO', previa.hash, decisao_id, previa);
      const evento_id = randomUUID(), data_evento = new Date(`${proposta.data_evento}T00:00:00.000Z`);
      const registro = await tx.insercao_retroativa_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, evento_id, data_evento, dados_evento: previa.dados_evento, impacto: { ...previa, revisao_orgaos: revisaoOrgaos, decisoes_orgao: decisoes_orgao ?? null, proposta, decisao_id: decisao_id ?? null }, justificativa, autoridade, evidencia, idempotencia: chave, criado_por_id: usuario } });
      await tx.$queryRaw`SELECT set_config('provisao.insercao_retroativa_id', ${registro.id}, true)`;
      await tx.eventos_membresia.create({ data: { id: evento_id, igreja_id: igreja, pessoa_id: pessoa, data_evento, ...previa.dados_evento } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'insercao_retroativa_membresia', registro_id: registro.id } });
      return registro;
    });
  }
}
