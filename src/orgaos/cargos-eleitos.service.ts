import { contextosDasAtasRestritas } from '../secretaria/visibilidade-documentos';
import { contaDaSessao, decidirServico, type Ator, type Tx } from '../autorizacao/politica';
import { recursoDaIgreja } from '../feature-flags/feature-flags';
import { SecretariaBaseService, type AtorSecretaria } from '../secretaria/secretaria-base.service';
import { selecionarDocumentos, tabelasDocumentais } from '../secretaria/selecao-documental';
import { ordemDoAto } from './ordem-ato';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { ComposicaoService } from './composicao.service';
import { limiteExclusivoPorMeses, validarPrazoCargo } from './regras-periodos';
import { atoAnterior, hashAto, transacaoComRetentativa, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const provaAta = z.strictObject({ versao_id: z.uuid(), trecho: z.string().trim().min(1).max(1000) });
const referenciaEleicao = provaAta.partial({ trecho: true });
const comprovacao = z.strictObject({ eleicao: referenciaEleicao, posse: referenciaEleicao, sucede_id: z.uuid().optional(), confirmar_historico: z.literal(true).optional() });
const entrada = z.object({ pessoa_id: z.uuid(), data_eleicao: dia, data_posse: dia, ordem_efeito: z.number().int().min(1).max(9999).optional(), termino_previsto: dia, comprovacao: comprovacao.optional(), autoridade: z.string().trim().min(1).max(255).optional(), evidencia: z.string().trim().min(1).max(1000).optional(), idempotencia: z.uuid() }).strict().refine(v => !!v.comprovacao || !!(v.autoridade && v.evidencia));
const encerramento = z.object({ data_efeito: dia, ordem_efeito: z.number().int().min(1).max(9999).optional(), comprovacao: provaAta.optional(), motivo: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();
const data = (valor: string) => new Date(`${valor}T00:00:00Z`);

/** Registro de ato eleitoral já praticado; não confere poder de deliberação ao operador. */
@Injectable()
export class CargosEleitosService {
  constructor(private readonly prisma: PrismaService, private readonly composicao: ComposicaoService, private readonly secretaria?: SecretariaBaseService) {}

  private async poder(tx: Tx, igreja: string, usuario: string, ator?: AtorSecretaria & Ator) {
    if (!this.secretaria || !ator || ator.igreja_id !== igreja || ator.sub !== usuario || !recursoDaIgreja('secretaria', igreja))
      throw new ForbiddenException('O registro com ata exige acesso à Secretaria.');
    const conta = await contaDaSessao(tx, ator);
    const decisao = await decidirServico(tx, conta, 'CARGOS_REGISTRAR');
    if (!conta.pessoa_id || !decisao.permite) throw new ForbiddenException('Atribuição vigente de registro de cargos necessária.');
    return { pessoa: conta.pessoa_id, atribuicao: decisao.origem!, podeRegistrarParaSi: conta.perfil === 'ADMINISTRADOR' };
  }

  private async escopoAtas(tx: Tx, ator: AtorSecretaria, orgao: string, hoje: string) {
    const restritos = await contextosDasAtasRestritas(tx, ator.igreja_id, ator.sub);
    return Prisma.sql`
      ${tabelasDocumentais} WHERE d.igreja_id = ${ator.igreja_id} AND c.orgao_id = ${orgao}
      AND d.tipo = 'ATA' AND v.numero = d.versao_atual AND d.estado IN ('APROVADO','EXPEDIDO','LEGADA_CONFERIDA')
      AND v.data_documento <= ${data(hoje)}::date
      AND (NOT d.restrito ${restritos.length ? Prisma.sql`OR d.contexto_id IN (${Prisma.join(restritos)})` : Prisma.empty})`;
  }

  atas(ator: AtorSecretaria & Ator, orgao: string, filtros: unknown) {
    return this.prisma.$transaction(async tx => {
      await this.poder(tx, ator.igreja_id, ator.sub, ator);
      const reunioes = (await this.secretaria!.concessoes(tx, ator)).filter(c => c.pode_consultar_restritos).map(c => c.contexto_id);
      return selecionarDocumentos(tx, await this.escopoAtas(tx, ator, orgao, await hojeDaIgreja(tx, ator.igreja_id)), filtros, false, reunioes);
    }, { isolationLevel: 'RepeatableRead' });
  }

  private async configuracaoNaPosse(tx: Tx, igreja_id: string, orgao_id: string, posse: string, historico: boolean) {
    const diaPosse = data(posse);
    const vigente = await tx.versao_orgao.findFirst({ where: { igreja_id, orgao_id,
      inicio: { lte: diaPosse }, OR: [{ fim: null }, { fim: { gt: diaPosse } }] } });
    if (vigente || !historico) return vigente;
    return tx.versao_orgao.findFirst({ where: { igreja_id, orgao_id, inicio: { gt: diaPosse } }, orderBy: { inicio: 'asc' } });
  }

  candidatos(ator: AtorSecretaria & Ator, orgaoId: string, cargoId: string, filtros: unknown) {
    const parsed = z.strictObject({ eleicao: dia, posse: dia, busca: z.string().trim().max(100).optional(), pessoa_id: z.uuid().optional() }).safeParse(filtros);
    if (!parsed.success || parsed.data.eleicao > parsed.data.posse) throw new BadRequestException('Confira as datas da eleição e da posse.');
    const { eleicao, posse, busca, pessoa_id } = parsed.data;
    return this.prisma.$transaction(async tx => {
      const igreja_id = ator.igreja_id;
      const operador = await this.poder(tx, igreja_id, ator.sub, ator);
      const cargo = await tx.cargo_orgao.findFirst({ where: { id: cargoId, igreja_id, orgao_id: orgaoId, ativo: true, orgao: { ativo: true } },
        select: { codigo: true, funcao: true, orgao: { select: { tipo: true } } } });
      const tipo = cargo?.orgao.tipo;
      if (!cargo || (tipo !== 'CONSELHO' && tipo !== 'JUNTA')) throw new NotFoundException('Vaga indisponível.');
      const [naEleicao, naPosse] = await Promise.all([eleicao, posse].map(d => this.composicao.consultarNaTransacao(tx, igreja_id, tipo, d, undefined, orgaoId)));
      const idsEleicao = new Set(naEleicao.membros.filter(m => !m.revisao_pendente).map(m => m.pessoa_id));
      const idsPosse = naPosse.membros.filter(m => !m.revisao_pendente && idsEleicao.has(m.pessoa_id)).map(m => m.pessoa_id);
      const tesouraria = tipo === 'CONSELHO' && (cargo.codigo === 'TESOUREIRO' || cargo.funcao === 'TESOUREIRO');
      const diaPosse = data(posse);
      const candidatos = await tx.pessoas.findMany({ where: { igreja_id, id: { equals: pessoa_id,
        ...(!operador.podeRegistrarParaSi && { not: operador.pessoa }),
        ...(tesouraria ? { notIn: [...naEleicao.situacao_indeterminada, ...naPosse.situacao_indeterminada,
          ...naEleicao.membros.filter(m => m.revisao_pendente).map(m => m.pessoa_id), ...naPosse.membros.filter(m => m.revisao_pendente).map(m => m.pessoa_id)] } : { in: idsPosse }) },
        ...(busca && { nome_completo: { contains: busca, mode: 'insensitive' } }),
        ...(tesouraria && { eventos_membresia: { some: { rol: 'COMUNGANTES', data_evento: { lte: data(eleicao) } } } }) },
        select: { id: true, nome_completo: true, eventos_membresia: { where: { data_evento: { lte: diaPosse } }, select: { data_evento: true, ordem_dia: true, rol: true } } },
        orderBy: [{ nome_completo: 'asc' }, { id: 'asc' }] });
      const aptos = new Set(idsPosse);
      const elegiveis = candidatos.filter(p => [eleicao, posse].every(d => {
        if (aptos.has(p.id)) return true;
        const rol = eventoVigente(p.eventos_membresia, data(d));
        return tesouraria && rol.situacao === 'DEFINIDO' && rol.evento.rol === 'COMUNGANTES';
      })).slice(0,50);
      const configuracao = await this.configuracaoNaPosse(tx, igreja_id, orgaoId, posse, posse < await hojeDaIgreja(tx, igreja_id));
      const prazos = z.object({ cargo_prazo_sugerido_meses: z.number().int().positive().optional(),
        cargo_prazo_maximo_meses: z.number().int().positive().optional() }).safeParse(configuracao?.configuracao);
      const teto = tipo === 'JUNTA' ? 12 : 60;
      const meses = Math.min(teto, prazos.data?.cargo_prazo_sugerido_meses ?? teto, prazos.data?.cargo_prazo_maximo_meses ?? teto);
      const terminoPadrao = data(limiteExclusivoPorMeses(posse, meses));
      terminoPadrao.setUTCDate(terminoPadrao.getUTCDate() - 1);
      return Promise.all(elegiveis.map(async p => {
        const oficial = await tx.oficial.findMany({ where: { igreja_id, pessoa_id: p.id, tipo: { in: tipo === 'JUNTA' ? ['DIACONO'] : ['PRESBITERO_REGENTE','PRESBITERO_DOCENTE'] } },
          select: { mandatos: { where: { data_posse: { lte: diaPosse }, OR: [{ orgao_id: null }, { orgao_id: orgaoId }],
            AND: [{ OR: [{ termino_efetivo: { gte: diaPosse } }, { termino_efetivo: null, termino_previsto: { gte: diaPosse } }] }] },
            select: { termino_efetivo: true, termino_previsto: true } },
            vinculos_pastorais: { where: { exercicio_institucional: true, data_inicio: { lte: diaPosse }, OR: [{ data_fim: null }, { data_fim: { gte: diaPosse } }] }, select: { data_fim: true } } } });
        const fins = oficial.flatMap(o => [...o.mandatos.map(m => m.termino_efetivo ?? m.termino_previsto), ...o.vinculos_pastorais.map(v => v.data_fim)]);
        const fim = fins.includes(null) ? null : fins.sort((a, b) => +b! - +a!)[0] ?? null;
        return { id: p.id, nome_completo: p.nome_completo, termino_sugerido: (fim && fim < terminoPadrao ? fim : terminoPadrao).toISOString().slice(0,10),
          limite_exercicio: fim?.toISOString().slice(0,10) ?? null };
      }));
    }, { isolationLevel: 'RepeatableRead' });
  }

  private async ata(tx: Tx, escopo: Prisma.Sql, prova: z.infer<typeof referenciaEleicao>) {
    const [ata] = await tx.$queryRaw<{ documento_id: string; data: Date }[]>`
      SELECT d.id AS documento_id, v.data_documento AS data
      ${escopo} AND v.id = ${prova.versao_id} FOR SHARE OF d, v`;
    if (!ata) throw new NotFoundException('Ata indisponível para este órgão.');
    return { ...ata, versao_id: prova.versao_id, trecho: prova.trecho ?? 'Referência à ata integral.' };
  }

  private async referenciar(tx: Tx, igreja_id: string, registrado_por_id: string, ato_orgao_id: string, etapa: string, ata: Awaited<ReturnType<CargosEleitosService['ata']>>) {
    await tx.referencia_ata_institucional.create({ data: { igreja_id, registrado_por_id, ato_orgao_id, etapa, sequencia: 1,
      ata_documento_id: ata.documento_id, versao_id: ata.versao_id, justificativa: ata.trecho } });
  }

  async registrar(igrejaId: string, usuarioId: string, orgaoId: string, cargoId: string, dados: z.infer<typeof entrada>, ator?: AtorSecretaria & Ator) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados do cargo inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'ELEICAO_CARGO', orgaoId, cargoId, dados: v });
    return transacaoComRetentativa(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const operador = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO', ...(v.comprovacao && ator?.perfil === 'COMUM' ? ['COMUM' as const] : [])] } }, select: { id: true, pessoa_id: true } });
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const poder = v.comprovacao ? await this.poder(tx, igrejaId, usuarioId, ator) : null;
      if (operador.pessoa_id === v.pessoa_id && !poder?.podeRegistrarParaSi) throw new ForbiddenException('O titular exige registro por outra pessoa.');
      const hoje = await hojeDaIgreja(tx, igrejaId);
      const anterior = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'ELEICAO_CARGO', hash }, 'ocupacao_id');
      if (anterior) return anterior;
      if (v.data_eleicao > hoje || v.data_eleicao > v.data_posse || (v.data_posse < hoje && !v.comprovacao?.confirmar_historico) || (!v.comprovacao && v.data_posse !== hoje))
        throw new BadRequestException('Confira as datas e confirme o registro histórico para uma posse anterior a hoje.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, ativo: true, tipo: { in: ['CONSELHO', 'JUNTA'] } } });
      if (!orgao || (orgao.tipo !== 'CONSELHO' && orgao.tipo !== 'JUNTA')) throw new NotFoundException('Órgão oficial não encontrado.');
      if (ator && !v.comprovacao && orgao.tipo_padrao === orgao.tipo && recursoDaIgreja('secretaria', igrejaId))
        throw new BadRequestException('Informe as atas de eleição e posse pela ficha do órgão.');
      let provas: { eleicao: Awaited<ReturnType<CargosEleitosService['ata']>>; posse: Awaited<ReturnType<CargosEleitosService['ata']>> } | null = null;
      let versaoId: string | null = null;
      let prazoConfigurado: number | undefined;
      let continuidade: 'REELEICAO' | 'SUCESSAO' | null = null;
      const historico = v.data_posse < hoje;
      if (v.comprovacao) {
        if (orgao.data_criacao && orgao.data_criacao > data(v.data_eleicao))
          throw new BadRequestException('A eleição antecede a data de instituição do órgão.');
        const configuracao = await this.configuracaoNaPosse(tx, igrejaId, orgaoId, v.data_posse, historico);
        const regras = z.object({ atos: z.object({ eleicao_cargo: z.string(), posse_cargo: z.string() }),
          cargo_prazo_maximo_meses: z.number().int().min(1).max(60).optional() }).safeParse(configuracao?.configuracao);
        if (!configuracao || !regras.success || regras.data.atos.eleicao_cargo !== orgao.tipo || regras.data.atos.posse_cargo !== orgao.tipo)
          throw new BadRequestException('Configuração de eleição e posse indisponível para este órgão.');
        versaoId = configuracao.id;
        prazoConfigurado = regras.data.cargo_prazo_maximo_meses;
        const escopo = await this.escopoAtas(tx, ator!, orgaoId, hoje);
        provas = { eleicao: await this.ata(tx, escopo, v.comprovacao.eleicao), posse: await this.ata(tx, escopo, v.comprovacao.posse) };
        if (+provas.eleicao.data !== +data(v.data_eleicao) || provas.posse.data < provas.eleicao.data)
          throw new BadRequestException('Confira a data da eleição e a ata que documenta a posse.');
      }
      const ordem = await ordemDoAto(tx, igrejaId, orgaoId, data(v.data_posse), v.ordem_efeito);
      const cargo = await tx.cargo_orgao.findFirst({ where: { id: cargoId, orgao_id: orgaoId, igreja_id: igrejaId, ativo: true } });
      if (!cargo) throw new NotFoundException('Cargo não encontrado neste órgão.');
      try { validarPrazoCargo(orgao.tipo, v.data_posse, v.termino_previsto); } catch { throw new BadRequestException('Prazo incompatível com o órgão.'); }
      if (prazoConfigurado && v.termino_previsto >= limiteExclusivoPorMeses(v.data_posse, prazoConfigurado))
        throw new BadRequestException('O término excede o prazo máximo da configuração em vigor na posse.');
      await tx.$queryRaw`SELECT id FROM oficial WHERE igreja_id = ${igrejaId} AND pessoa_id = ${v.pessoa_id} ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${v.pessoa_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      if (!await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id: igrejaId }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      let oficialNaPosse = false;
      for (const referencia of new Set([v.data_eleicao, v.data_posse])) {
        const situacao = await this.composicao.consultarNaTransacao(tx, igrejaId, orgao.tipo, referencia, [v.pessoa_id], orgaoId);
        const membro = situacao.membros.find(m => m.pessoa_id === v.pessoa_id);
        if (situacao.situacao_indeterminada.includes(v.pessoa_id) || membro?.revisao_pendente) throw new BadRequestException('Situação institucional exige revisão.');
        if (referencia === v.data_posse) oficialNaPosse = !!membro;
        if (!membro) {
          // O tesoureiro do Conselho pode não ser oficial; isso não lhe confere voto.
          if (orgao.tipo !== 'CONSELHO' || (cargo.funcao !== 'TESOUREIRO' && cargo.codigo !== 'TESOUREIRO')) throw new BadRequestException('O cargo exige oficial em exercício na eleição e na posse.');
          const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: v.pessoa_id, data_evento: { lte: data(referencia) } }, select: { data_evento: true, ordem_dia: true, rol: true } });
          const rol = eventoVigente(eventos, data(referencia));
          if (rol.situacao !== 'DEFINIDO' || rol.evento.rol !== 'COMUNGANTES') throw new BadRequestException('Tesoureiro exige membresia comungante comprovada.');
        }
      }
      if (provas && oficialNaPosse) {
        const posse = data(v.data_posse), termino = data(v.termino_previsto);
        const oficial = await tx.oficial.findFirst({ where: { igreja_id: igrejaId, pessoa_id: v.pessoa_id,
          tipo: { in: orgao.tipo === 'CONSELHO' ? ['PRESBITERO_REGENTE','PRESBITERO_DOCENTE'] : ['DIACONO'] },
          OR: [{ mandatos: { some: { data_posse: { lte: posse }, OR: [{ orgao_id: orgaoId }, { orgao_id: null }],
            AND: [{ OR: [{ termino_efetivo: { gte: termino } }, { termino_efetivo: null, termino_previsto: { gte: termino } }] }] } } },
            { vinculos_pastorais: { some: { exercicio_institucional: true, data_inicio: { lte: posse }, OR: [{ data_fim: null }, { data_fim: { gte: termino } }] } } }] },
          select: { id: true } });
        if (!oficial) throw new BadRequestException('O término do cargo deve caber no período de exercício documentado do oficial.');
        const fim = await this.composicao.consultarNaTransacao(tx, igrejaId, orgao.tipo, v.termino_previsto, [v.pessoa_id], orgaoId);
        if (!fim.membros.some(m => m.pessoa_id === v.pessoa_id && !m.revisao_pendente))
          throw new BadRequestException('Exercício institucional indisponível no término previsto.');
      }
      const dataPosse = data(v.data_posse), terminoPrevisto = data(v.termino_previsto);
      const escopoCargo = { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId };
      let antecessorId: string | null = null;
      if (provas) {
        const anterior = await tx.ocupacao_cargo.findFirst({
          where: { ...escopoCargo, OR: [{ inicio: { lt: dataPosse } }, { inicio: dataPosse, inicio_ordem: { lt: ordem } }] },
          orderBy: [{ inicio: 'desc' }, { inicio_ordem: 'desc' }],
        });
        if (v.comprovacao?.sucede_id && v.comprovacao.sucede_id !== anterior?.id)
          throw new ConflictException('O titular anterior mudou. Confira o histórico deste cargo.');
        if (anterior) {
          if (anterior.pessoa_id !== v.pessoa_id && (!anterior.fim || anterior.fim > dataPosse ||
              (+anterior.fim === +dataPosse && anterior.fim_ordem! >= ordem)))
            throw new ConflictException('Registre o encerramento do titular anterior deste cargo antes da nova posse. A ocupação está no Histórico do órgão.');
          antecessorId = anterior.id;
          continuidade = anterior.pessoa_id === v.pessoa_id ? 'REELEICAO' : 'SUCESSAO';
        }
      }
      const colisao = await tx.ocupacao_cargo.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId,
        inicio: { lte: terminoPrevisto }, AND: [
          { OR: [{ fim: null }, { fim: { gt: dataPosse } }, { fim: dataPosse, fim_ordem: { gt: ordem } }] },
          { OR: [{ termino_previsto: null }, { termino_previsto: { gte: dataPosse } }] },
        ] }, select: { id: true } });
      if (colisao) throw new ConflictException('A vaga já possui titular ou sucessão agendada para o período.');
      const outras = await tx.ocupacao_cargo.findMany({ where: { igreja_id: igrejaId, orgao_id: orgaoId, pessoa_id: v.pessoa_id, cargo_id: { not: cargoId }, inicio: { lte: data(v.termino_previsto) }, AND: [{ OR: [{ fim: null }, { fim: { gt: data(v.data_posse) } }, { fim: data(v.data_posse), fim_ordem: { gt: ordem } }] }, { OR: [{ termino_previsto: null }, { termino_previsto: { gte: data(v.data_posse) } }] }] }, include: { cargo: { select: { permite_acumulacao: true } } } });
      if (outras.length && (!cargo.permite_acumulacao || outras.some(o => !o.cargo.permite_acumulacao))) throw new BadRequestException('Acumulação não autorizada para os cargos.');
      const ocupacao = await tx.ocupacao_cargo.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId, pessoa_id: v.pessoa_id, inicio: data(v.data_posse), inicio_ordem: ordem, termino_previsto: data(v.termino_previsto) } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'ELEICAO_CARGO', data_efeito: data(v.data_posse), autoridade: v.autoridade ?? orgao.nome, evidencia: v.evidencia ?? `Ata da eleição de ${v.data_eleicao}`, idempotencia, hash_requisicao: hash, detalhes: { ordem_efeito: ordem, cargo_id: cargoId, ocupacao_id: ocupacao.id, data_eleicao: v.data_eleicao, termino_previsto: v.termino_previsto, oficial_na_posse: oficialNaPosse, ...(versaoId && { versao_orgao_id: versaoId, atribuicao_id: poder!.atribuicao, sucede_id: antecessorId, continuidade, transcricao_historica: historico }) } } });
      if (provas) {
        await this.referenciar(tx, igrejaId, usuarioId, ato.id, 'ELEICAO', provas.eleicao);
        await this.referenciar(tx, igrejaId, usuarioId, ato.id, 'POSSE', provas.posse);
      }
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, cargo_id: cargoId, ocupacao_id: ocupacao.id } } });
      return { ato_id: ato.id, ocupacao_id: ocupacao.id };
    }, Prisma.TransactionIsolationLevel.ReadCommitted).catch((erro: unknown) => {
      if (erro instanceof Prisma.PrismaClientUnknownRequestError && erro.message.includes('cargo_sem_titulares_sobrepostos'))
        throw new ConflictException('A vaga já possui titular ou sucessão agendada para o período.');
      throw erro;
    });
  }

  async encerrar(igrejaId: string, usuarioId: string, orgaoId: string, ocupacaoId: string, dados: z.infer<typeof encerramento>, ator?: AtorSecretaria & Ator) {
    const parsed = encerramento.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados de encerramento inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'ENCERRAMENTO_CARGO', orgaoId, ocupacaoId, dados: v });
    const efeito = data(v.data_efeito);
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      if (!await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO', ...(v.comprovacao && ator?.perfil === 'COMUM' ? ['COMUM' as const] : [])] } }, select: { id: true } })) throw new ForbiddenException('Operador não autorizado.');
      const hoje = await hojeDaIgreja(tx, igrejaId);
      const poder = v.comprovacao ? await this.poder(tx, igrejaId, usuarioId, ator) : null;
      const anterior = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'ENCERRAMENTO_CARGO', hash }, 'ocupacao_id');
      if (anterior) return anterior;
      if (!v.comprovacao && v.data_efeito !== hoje) throw new BadRequestException('Informe a ata para registrar o encerramento em outra data.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, tipo: { in: ['CONSELHO', 'JUNTA'] } }, select: { id: true, ativo: true, tipo_padrao: true, tipo: true } });
      if (!orgao) throw new NotFoundException('Órgão oficial não encontrado.');
      const ordem = await ordemDoAto(tx, igrejaId, orgaoId, efeito, v.ordem_efeito);
      const ocupacao = await tx.ocupacao_cargo.findFirst({ where: { id: ocupacaoId, igreja_id: igrejaId, orgao_id: orgaoId } });
      if (!ocupacao) throw new NotFoundException('Ocupação não encontrada.');
      const atoEleicao = await tx.ato_orgao.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, tipo: 'ELEICAO_CARGO',
        detalhes: { path: ['ocupacao_id'], equals: ocupacao.id } }, select: { detalhes: true } });
      const temComprovacao = !!(atoEleicao?.detalhes as { versao_orgao_id?: string } | null)?.versao_orgao_id;
      if (((temComprovacao || ator && orgao.tipo_padrao === orgao.tipo && recursoDaIgreja('secretaria', igrejaId)) && !poder) || (poder?.pessoa === ocupacao.pessoa_id && !poder.podeRegistrarParaSi))
        throw new ForbiddenException('O encerramento exige ata e permissão para registrar este ato.');
      const provaFim = v.comprovacao ? await this.ata(tx, await this.escopoAtas(tx, ator!, orgaoId, hoje), v.comprovacao) : null;
      if (ocupacao.fim || (ocupacao.inicio > efeito || (ocupacao.inicio.getTime() === efeito.getTime() && ocupacao.inicio_ordem >= ordem)) || (!poder && (!ocupacao.termino_previsto || ocupacao.termino_previsto < efeito))) throw new BadRequestException('Ocupação não está vigente ou exige ordenação do mesmo dia.');
      if (ocupacao.termino_previsto && +efeito > +ocupacao.termino_previsto + 86_400_000)
        throw new BadRequestException('A data de encerramento deve respeitar o período da ocupação. Informe quando o titular deixou o cargo.');
      const sucessor = await tx.ocupacao_cargo.findFirst({ where: {
        igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: ocupacao.cargo_id,
        AND: [
          { OR: [{ inicio: { gt: ocupacao.inicio } }, { inicio: ocupacao.inicio, inicio_ordem: { gt: ocupacao.inicio_ordem } }] },
          { OR: [{ inicio: { lt: efeito } }, { inicio: efeito, inicio_ordem: { lte: ordem } }] },
        ],
      }, select: { id: true } });
      if (sucessor) throw new ConflictException('O encerramento deve anteceder a posse seguinte neste cargo.');
      await tx.ocupacao_cargo.update({ where: { id: ocupacao.id }, data: { fim: efeito, fim_ordem: ordem } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'ENCERRAMENTO_CARGO', data_efeito: efeito, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { ordem_efeito: ordem, ocupacao_id: ocupacao.id, motivo: v.motivo } } });
      if (provaFim) await this.referenciar(tx, igrejaId, usuarioId, ato.id, 'ATO', provaFim);
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, ocupacao_id: ocupacao.id, data_efeito: v.data_efeito } } });
      return { ato_id: ato.id, ocupacao_id: ocupacao.id };
    });
  }
}
