import type { Ator } from '../autorizacao/politica';
import { exigirServicoHistorico } from './autorizacao-historico';
import { createHash } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, oficial_evento_tipo, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { exigirAcessoSensivel } from './acesso-sensivel.service';
import { avaliarExercicio } from './exercicio';
const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const texto = z.string().trim().min(1).max(1000);
const propostaSchema = z.object({ tipo: z.nativeEnum(oficial_evento_tipo), data_efeito: dia, ordem: z.number().int().min(1).max(9999), autoridade: texto, evidencia: texto, observacoes: z.string().trim().max(1000).nullable(), evento_restaurado_id: z.string().uuid().nullable() }).strict().refine(v => (v.tipo === 'RESTAURACAO') === !!v.evento_restaurado_id);
const aplicarSchema = propostaSchema.safeExtend({ hash_previa: z.string().regex(/^[a-f0-9]{64}$/), justificativa: texto, idempotencia: z.string().uuid(), ciente: z.literal(true) }).strict();
type Proposta = z.infer<typeof propostaSchema>; type Aplicacao = z.infer<typeof aplicarSchema>; type Tx = Prisma.TransactionClient;
const civil = (d: Date) => d.toISOString().slice(0, 10);
@Injectable()
export class InsercaoRetroativaOficialService {
  constructor(private readonly prisma: PrismaService) {}
  private async autorizar(tx: Tx, igreja: string, usuario: string, modo: 'consultar' | 'registrar', ator?: Ator) {
    const escrita = modo === 'registrar';
    await exigirServicoHistorico(tx, igreja, usuario, escrita ? 'HISTORICO_OFICIAIS_REGISTRAR' : 'HISTORICO_OFICIAIS_CONSULTAR', escrita, ator);
    await exigirAcessoSensivel(tx, igreja, usuario, modo);
  }
  private async calcular(tx: Tx, igreja: string, oficialId: string, proposta: Proposta) {
    const oficial = await tx.oficial.findFirst({ where: { id: oficialId, igreja_id: igreja }, select: { id: true, tipo: true } }); if (!oficial) throw new NotFoundException('Oficial não encontrado nesta igreja.');
    const [eventos, mandatos, vinculos] = await Promise.all([
      tx.evento_oficial.findMany({ where: { igreja_id: igreja, oficial_id: oficialId }, orderBy: [{ data_efeito: 'asc' }, { ordem: 'asc' }] }),
      tx.mandato_oficial.findMany({ where: { igreja_id: igreja, oficial_id: oficialId }, select: { id: true, data_eleicao: true, data_posse: true, termino_previsto: true, termino_efetivo: true }, orderBy: { id: 'asc' } }),
      tx.vinculo_pastoral.findMany({ where: { igreja_id: igreja, oficial_id: oficialId, exercicio_institucional: true }, select: { id: true, data_inicio: true, data_fim: true }, orderBy: { id: 'asc' } }),
    ]);
    const data = new Date(`${proposta.data_efeito}T00:00:00.000Z`);
    if (eventos.some(e => e.data_efeito.getTime() === data.getTime() && e.ordem === proposta.ordem)) throw new BadRequestException('A ordem indicada já está ocupada nessa data.');
    if (!eventos.some(e => e.data_efeito > data || (e.data_efeito.getTime() === data.getTime() && e.ordem > proposta.ordem))) throw new BadRequestException('Use o registro comum para evento posterior ao histórico.');
    if (proposta.tipo === 'RESTAURACAO') {
      const alvo = eventos.find(e => e.id === proposta.evento_restaurado_id);
      if (!alvo || !['LICENCA', 'SUSPENSAO', 'DISPONIBILIDADE', 'DEPOSICAO'].includes(alvo.tipo) || alvo.data_efeito > data || (alvo.data_efeito.getTime() === data.getTime() && alvo.ordem >= proposta.ordem) || eventos.some(e => e.evento_restaurado_id === alvo.id)) throw new BadRequestException('A restauração exige afastamento anterior ainda não restaurado do mesmo oficial.');
    }
    const novo = { id: 'PROJETADO', tipo: proposta.tipo, data_efeito: data, ordem: proposta.ordem, evento_restaurado_id: proposta.evento_restaurado_id };
    const projetados = [...eventos, novo].sort((a, b) => a.data_efeito.getTime() - b.data_efeito.getTime() || a.ordem - b.ordem);
    const impedimentos = new Set<string>();
    for (const e of projetados) {
      if (e.tipo === 'ORDENACAO') continue;
      if (e.tipo === 'RESTAURACAO') { if (!e.evento_restaurado_id || !impedimentos.delete(e.evento_restaurado_id)) throw new BadRequestException('A sequência projetada contém restauração sem afastamento anterior ativo.'); }
      else impedimentos.add(e.id);
    }
    const pontos = new Set<number>([data.getTime()]);
    for (const e of eventos) if (e.data_efeito >= data) pontos.add(e.data_efeito.getTime());
    for (const m of mandatos) { if (m.data_posse >= data) pontos.add(m.data_posse.getTime()); const fim = m.termino_efetivo ?? m.termino_previsto; if (fim >= data) pontos.add(fim.getTime()); }
    for (const v of vinculos) { if (v.data_inicio >= data) pontos.add(v.data_inicio.getTime()); if (v.data_fim && v.data_fim >= data) pontos.add(v.data_fim.getTime()); }
    const dias = [...pontos].sort((a, b) => a - b).map(t => new Date(t));
    const periodos = [
      ...mandatos.map(m => ({ id: m.id, tipo: 'MANDATO' as const, data_posse: m.data_posse, termino_previsto: m.termino_previsto, termino_efetivo: m.termino_efetivo })),
      ...vinculos.map(v => ({ id: v.id, tipo: 'VINCULO_PASTORAL' as const, data_posse: v.data_inicio, termino_previsto: new Date('9999-12-31T00:00:00.000Z'), termino_efetivo: v.data_fim })),
    ];
    const analise = periodos.flatMap(periodo => dias.filter(d => d >= periodo.data_posse && d <= (periodo.termino_efetivo ?? periodo.termino_previsto)).map(d => ({ id: periodo.id, tipo: periodo.tipo, data: civil(d), antes: avaliarExercicio(periodo, eventos, d), depois: avaliarExercicio(periodo, projetados, d) })));
    const posseInvalida = mandatos.some(m => m.data_posse >= data && avaliarExercicio(m, eventos, m.data_posse).em_exercicio && !avaliarExercicio(m, projetados, m.data_posse).em_exercicio);
    const impacto = { oficial_id: oficialId, tipo_oficial: oficial.tipo, proposta, alteracoes: analise.filter(a => a.antes.em_exercicio !== a.depois.em_exercicio || a.antes.motivo !== a.depois.motivo), posse_invalida: posseInvalida, bloqueada: posseInvalida, observacao: 'A análise compara exercício cadastrado nas datas dos eventos e limites dos períodos. Não reavalia membresia, competência documental ou atos já praticados; a ordem intradiária depende da sequência informada.' };
    const estado = { igreja, impacto, eventos, mandatos, vinculos };
    return { ...impacto, hash: createHash('sha256').update(JSON.stringify(estado)).digest('hex') };
  }
  async previa(igreja: string, usuario: string, oficial: string, dados: Proposta, ator?: Ator) {
    const p = propostaSchema.safeParse(dados); if (!p.success) throw new BadRequestException('Proposta inválida.');
    return this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'consultar', ator); const r = await this.calcular(tx, igreja, oficial, p.data); await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_insercao_oficial', registro_id: oficial } }); return r; }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async listar(igreja: string, usuario: string, oficial: string, ator?: Ator) {
    return this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'consultar', ator); if (!await tx.oficial.findFirst({ where: { id: oficial, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Oficial não encontrado nesta igreja.'); const r = await tx.insercao_retroativa_oficial.findMany({ where: { igreja_id: igreja, oficial_id: oficial }, select: { id: true, evento_id: true, impacto: true, justificativa: true, criado_em: true, criado_por: { select: { nome_usuario: true } } }, orderBy: { criado_em: 'desc' } }); await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_insercao_oficial', registro_id: oficial } }); return r; });
  }
  async aplicar(igreja: string, usuario: string, oficial: string, dados: Aplicacao, ator?: Ator) {
    const p = aplicarSchema.safeParse(dados); if (!p.success) throw new BadRequestException('Inclusão inválida.');
    const { hash_previa, justificativa, idempotencia, ciente: _ciente, ...proposta } = p.data, chave = idempotencia.toLowerCase();
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'registrar', ator);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':insercao-oficial:' + chave}, 0))`;
      const anterior = await tx.insercao_retroativa_oficial.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: chave } } });
      if (anterior) { const impacto = anterior.impacto as Prisma.JsonObject; if (anterior.oficial_id !== oficial || anterior.criado_por_id !== usuario || anterior.justificativa !== justificativa || impacto.hash !== hash_previa || !impacto.proposta || typeof impacto.proposta !== 'object' || Object.entries(proposta).some(([k, v]) => (impacto.proposta as Prisma.JsonObject)[k] !== v)) throw new ConflictException('Chave já utilizada para outra inclusão.'); return anterior; }
      await tx.$queryRaw`SELECT id FROM oficial WHERE id = ${oficial} AND igreja_id = ${igreja} FOR UPDATE`;
      const previa = await this.calcular(tx, igreja, oficial, proposta);
      if (previa.hash !== hash_previa) throw new ConflictException('Os dados mudaram; gere nova prévia antes de confirmar.');
      if (previa.bloqueada) throw new ConflictException('A inclusão exige revisão institucional da posse.');
      const evento = await tx.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial, tipo: proposta.tipo, data_efeito: new Date(`${proposta.data_efeito}T00:00:00.000Z`), ordem: proposta.ordem, autoridade: proposta.autoridade, evidencia: proposta.evidencia, observacoes: proposta.observacoes, evento_restaurado_id: proposta.evento_restaurado_id } });
      const registro = await tx.insercao_retroativa_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial, evento_id: evento.id, impacto: previa, justificativa, idempotencia: chave, criado_por_id: usuario } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'evento_oficial', registro_id: evento.id, dados_novos: { insercao_retroativa_id: registro.id } } });
      return registro;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
