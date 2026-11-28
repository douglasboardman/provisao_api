import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { linhasDoRol, type EventoDoRol } from './rol-assembleia';
import { ComposicaoService } from '../orgaos/composicao.service';
import { dataCivilNoFuso } from '../orgaos/relogio-igreja';
import { SecretariaBaseService, dataCivil, json, type AtorSecretaria, type Tx } from './secretaria-base.service';
import { SecretariaCadastrosService } from './secretaria-cadastros.service';
import * as dto from './secretaria.dto';
import { quorumDoModelo } from './regras-modelo-reuniao';
import { aplicarMesa, conferirVotacao, ehPapelMesa, escopoMesa, incluirOficialMesa, mesaVigente } from './mesa-assembleia';
import { prepararCampos } from './campos-documento';

type Reuniao = Awaited<ReturnType<SecretariaCadastrosService['reuniao']>>;
const folhaSchema = z.strictObject({ ...dto.chave, referencia: dto.dia });
const regencia = z.strictObject({
  impedimentos: z.array(z.strictObject({ oficial_id: z.uuid(), motivo: z.enum(['AUSENTE','IMPEDIDO']), fundamento: dto.texto })).max(40),
  determinacao_presbiterio: dto.texto.optional(),
});
const mesaSchema = z.strictObject({ ...dto.chave, ...dto.revisao, presidente_oficial_id: z.uuid(), secretario_id: z.uuid(),
  criterio_presidencia: regencia.optional(), votantes_confirmados: z.array(z.uuid()).max(1000).optional(),
  confirmar_presencas: z.array(z.uuid()).min(1).max(1000), universo: z.number().int().nonnegative().max(1000000),
  quorum: z.strictObject({ minimo: z.number().int().nonnegative(), competencia: dto.texto, fundamento: dto.texto }).optional(),
  vigente_desde: z.iso.datetime({ offset: true }), motivo: z.enum(['PRESIDENCIA_INSTITUCIONAL','AUSENCIA','ELEICAO_PASTORAL','SUBSTITUICAO','OUTRO']), fundamento: dto.texto });
const resumoFolha = { id: true, versao: true, referencia: true, extraida_em: true, identificacao: true } as const;
const porOrdem = { ordem: 'desc' } as const;

@Injectable()
export class AssembleiasService {
  constructor(private readonly base: SecretariaBaseService, private readonly cadastros: SecretariaCadastrosService,
    private readonly composicao: ComposicaoService) {}

  private async acesso(tx: Tx, a: AtorSecretaria, id: string) {
    const u = await this.base.operador(tx, a);
    const r = await this.cadastros.reuniao(tx, a, id);
    const c = await this.base.contexto(tx, a, r.contexto_id);
    if (c.orgao.tipo !== 'ASSEMBLEIA_GERAL') throw new BadRequestException('Selecione uma Assembleia Geral.');
    const instalar = c.orgao.ativo && u.perfil !== 'AUDITOR' && (await this.base.concessoes(tx, a, c.id)).some(p => p.pode_instalar_mesa);
    const papeis = !instalar && u.perfil !== 'AUDITOR' ? (u.perfil === 'COMUM'
      ? await this.base.papeisContextuais(tx, c, u) : await this.base.atuacao.papeis(tx, c, u.pessoa_id)) : new Set<string>();
    const secretario = papeis.size > 0 && !!await tx.cargo_orgao.findFirst({ where: { igreja_id: a.igreja_id, id: { in: [...papeis] },
      OR: [{ funcao: 'SECRETARIO' }, { codigo: { in: ['SECRETARIO','PRIMEIRO_SECRETARIO','SEGUNDO_SECRETARIO'] } }] }, select: { id: true } });
    return { r, instalar, folha: instalar || secretario && await this.base.podePreparar(tx, a, c.id, u) };
  }

  private async exigir(tx: Tx, a: AtorSecretaria, id: string, acao: 'folha' | 'instalar') {
    const acesso = await this.acesso(tx, a, id);
    if (!acesso[acao]) throw new ForbiddenException('Competência insuficiente para esta ação na assembleia.');
    return acesso.r;
  }

  private async oficiais(tx: Tx, r: Reuniao) {
    const dia = r.data.toISOString().slice(0,10);
    const composicao = await this.composicao.consultarNaTransacao(tx, r.igreja_id, 'CONSELHO', dia);
    const pendentes = new Set(composicao.situacao_indeterminada);
    const habilitados = new Map(composicao.membros.filter(m => !m.revisao_pendente && !pendentes.has(m.pessoa_id)).map(m => [m.pessoa_id, m.oficios]));
    const registros = await tx.oficial.findMany({ where: { igreja_id: r.igreja_id, pessoa_id: { in: [...habilitados.keys()] } },
      select: { id: true, pessoa_id: true, tipo: true, pessoa: { select: { nome_completo: true } } } });
    const candidatos = registros.filter(o => habilitados.get(o.pessoa_id)?.includes(o.tipo))
      .map(({ pessoa, ...o }) => ({ ...o, nome: pessoa.nome_completo }));
    const titulares = await tx.presidencia_conselho.findMany({ where: { igreja_id: r.igreja_id, inicio: { lte: r.data }, OR: [{ fim: null }, { fim: { gt: r.data } }] }, select: { oficial_id: true }, take: 2 });
    const institucional = titulares.length === 1 && candidatos.some(o => o.id === titulares[0].oficial_id) ? titulares[0].oficial_id : null;
    const [vinculos, vices] = await Promise.all([
      tx.vinculo_pastoral.findMany({ where: { igreja_id: r.igreja_id, exercicio_institucional: true,
        oficial_id: { in: candidatos.filter(c => c.tipo === 'PRESBITERO_DOCENTE').map(c => c.id) },
        data_inicio: { lte: r.data }, OR: [{ data_fim: null }, { data_fim: { gte: r.data } }] },
        select: { oficial_id: true, modalidade: true } }),
      tx.ocupacao_cargo.findMany({ where: { igreja_id: r.igreja_id, cargo: { codigo: 'VICE_PRESIDENTE', ativo: true, orgao: { tipo: 'CONSELHO', ativo: true } },
        inicio: { lte: r.data }, OR: [{ fim: null }, { fim: { gt: r.data } }],
        AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: r.data } }] }] }, select: { pessoa_id: true } }),
    ]);
    const prioridade = [
      { ordem: 1, funcao: 'Pastor eleito ou designado', ids: [...new Set([...(institucional ? [institucional] : []),
        ...vinculos.filter(v => /\b(eleito|designado|titular)\b/i.test(v.modalidade) && !/auxiliar/i.test(v.modalidade)).map(v => v.oficial_id)])] },
      { ordem: 2, funcao: 'Pastor auxiliar', ids: vinculos.filter(v => /\bauxiliar\b/i.test(v.modalidade)).map(v => v.oficial_id) },
      { ordem: 3, funcao: 'Vice-presidente do Conselho', ids: candidatos.filter(c => c.tipo.startsWith('PRESBITERO_') && vices.some(v => v.pessoa_id === c.pessoa_id)).map(c => c.id) },
    ];
    return { oficiais: candidatos.map(c => ({ ...c, prioridade: prioridade.find(p => p.ids.includes(c.id))?.ordem ?? null }))
      .sort((a,b) => (a.prioridade ?? 4) - (b.prioridade ?? 4) || a.nome.localeCompare(b.nome, 'pt-BR')), institucional, prioridade };

  }

  ficha(a: AtorSecretaria, id: string) {
    return this.base.prisma.$transaction(async tx => {
      const { r, folha, instalar } = await this.acesso(tx,a,id);
      const folhas = folha ? await tx.folha_presenca_assembleia.findMany({ where: { reuniao_id: id, igreja_id: a.igreja_id }, select: resumoFolha, orderBy: { versao: 'desc' } }) : [];
      const mesas = await tx.mesa_assembleia.findMany({ where: { reuniao_id: id, igreja_id: a.igreja_id }, include: { ...incluirOficialMesa, operador: { select: { nome_usuario: true } } }, orderBy: porOrdem });
      const atual = mesas[0];
      return { orgao_id: (await this.base.contexto(tx, a, r.contexto_id)).orgao_id,
        votacao: conferirVotacao(atual ?? null, r.participantes, dto.reuniaoDadosSchema.parse(r.dados).quorum_minimo, false),
        pode_gerar: folha, pode_instalar: instalar, folhas, mesas, ...(instalar ? await this.oficiais(tx,r) : { oficiais: [], institucional: null }) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async rol(tx: Tx, igreja_id: string, referencia: string) {
    const dia = dataCivil(referencia);
    // Trazer todos os eventos do último dia de cada pessoa preserva ambiguidades do acervo.
    const eventos = await tx.$queryRaw<EventoDoRol[]>`
      WITH ultima_data AS (
        SELECT pessoa_id, MAX(data_evento) AS dia
        FROM eventos_membresia WHERE igreja_id = ${igreja_id} AND data_evento <= ${dia}
        GROUP BY pessoa_id
      )
      SELECT e.pessoa_id, p.nome_completo AS nome, e.data_evento, e.ordem_dia, e.rol::text
      FROM ultima_data u
      JOIN eventos_membresia e ON e.igreja_id = ${igreja_id} AND e.pessoa_id = u.pessoa_id AND e.data_evento = u.dia
      JOIN pessoas p ON p.id = e.pessoa_id AND p.igreja_id = e.igreja_id`;
    return linhasDoRol(eventos, dia);
  }

  previa(a: AtorSecretaria, id: string, referencia: string) {
    const dia = dto.validar(dto.dia, referencia);
    return this.base.prisma.$transaction(async tx => {
      await this.exigir(tx,a,id,'folha');
      return this.rol(tx,a.igreja_id,dia);
    }, { isolationLevel: 'RepeatableRead' });
  }

  gerar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(folhaSchema, dados);
    return this.base.comando(a,'ASSEMBLEIA_FOLHA',id,v, async tx => {
      const r = await this.cadastros.reuniao(tx,a,id);
      const igreja = await tx.igreja.findUniqueOrThrow({ where: { id: a.igreja_id }, select: { nome: true } });
      const anterior = await tx.folha_presenca_assembleia.findFirst({ where: { reuniao_id: id }, select: { versao: true }, orderBy: { versao: 'desc' } });
      const dados = dto.reuniaoDadosSchema.parse(r.dados);
      const identificacao = [igreja.nome, r.modalidade === 'AGO' ? 'Assembleia Geral Ordinária' : 'Assembleia Geral Extraordinária',
        r.data.toISOString().slice(0,10).split('-').reverse().join('/'), dados.horario_previsto, dados.local].filter(Boolean).join(' · ');
      const folha = await tx.folha_presenca_assembleia.create({ data: { reuniao_id: id, igreja_id: a.igreja_id, contexto_id: r.contexto_id,
        identificacao, versao: (anterior?.versao ?? 0) + 1, referencia: dataCivil(v.referencia), extraida_por: a.sub, linhas: json(await this.rol(tx,a.igreja_id,v.referencia)) } });
      return { id: folha.id };
    }, async tx => { await this.exigir(tx,a,id,'folha'); });
  }

  folha(a: AtorSecretaria, id: string, folhaId: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.exigir(tx,a,id,'folha');
      const f = await tx.folha_presenca_assembleia.findFirst({ where: { id: folhaId, reuniao_id: id, igreja_id: a.igreja_id }, select: { ...resumoFolha, linhas: true } });
      if (!f) throw new NotFoundException('Folha de presença não encontrada.');
      return f;
    });
  }

  instalar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(mesaSchema, dados);
    return this.base.comando(a,'ASSEMBLEIA_MESA',id,v, async tx => {
      const r = await this.cadastros.reuniao(tx,a,id);
      this.base.conferirRevisao(r.revisao,v.revisao);
      const rd = dto.reuniaoDadosSchema.parse(r.dados);
      if (rd.situacao && !['EM_ANDAMENTO','AGENDADA'].includes(rd.situacao) || rd.fim) throw new BadRequestException('A assembleia deve estar agendada ou em andamento.');
      const anterior = await mesaVigente(tx, r);
      const desde = new Date(v.vigente_desde);
      const fuso = await tx.configuracao_fuso_igreja.findUnique({ where: { igreja_id: a.igreja_id } });
      const dia = dataCivilNoFuso(desde, fuso?.fuso_iana ?? 'UTC');
      if (desde > new Date() || dia < rd.data || (rd.inicio ? desde < new Date(rd.inicio) : dia !== rd.data) || (anterior && desde <= anterior.vigente_desde))
        throw new BadRequestException('Confira a data e a hora de início desta composição da mesa.');
      const ultimaDecisao = await tx.deliberacao_ata.findFirst({ where: { reuniao_id: id }, orderBy: { criado_em: 'desc' } });
      if (ultimaDecisao && (!anterior || desde <= ultimaDecisao.criado_em))
        throw new BadRequestException('A instalação não pode retroagir a uma deliberação registrada.');
      const { oficiais, institucional } = await this.oficiais(tx,r);
      const presidente = oficiais.find(o => o.id === v.presidente_oficial_id);
      if (!presidente || v.motivo === 'PRESIDENCIA_INSTITUCIONAL' && presidente.id !== institucional)
        throw new BadRequestException('Escolha um oficial em exercício e o motivo correspondente à indicação.');
      if (presidente.pessoa_id === v.secretario_id) throw new BadRequestException('Escolha pessoas distintas para presidir e secretariar a assembleia.');
      const mesmaMesa = anterior?.presidente_oficial_id === presidente.id && anterior.secretario_id === v.secretario_id;
      const mudouVotantes = v.votantes_confirmados !== undefined &&
        JSON.stringify([...v.votantes_confirmados].sort()) !== JSON.stringify(Array.isArray(anterior?.votantes_confirmados) ? [...anterior.votantes_confirmados].sort() : null);
      if (mesmaMesa && !mudouVotantes && v.confirmar_presencas.every(id => rd.participantes.some(p => p.pessoa_id === id && p.presente)))
        throw new BadRequestException('A mesa e a conferência de participação já estão registradas.');
      const confirmados = new Set(v.confirmar_presencas);
      if (!confirmados.has(presidente.pessoa_id) || !confirmados.has(v.secretario_id)) throw new BadRequestException('Confirme a presença dos dois titulares.');
      const pessoas = await tx.pessoas.findMany({ where: { igreja_id: a.igreja_id, id: { in: [...confirmados] } }, select: { id: true, nome_completo: true } });
      if (pessoas.length !== confirmados.size) throw new BadRequestException('Participante indisponível na igreja.');
      const participantes = new Map(rd.participantes.map(p => [p.pessoa_id, { ...p, papeis: p.papeis.filter(papel => !ehPapelMesa(papel)) }]));
      for (const pessoa of pessoas) {
        const p = participantes.get(pessoa.id) ?? { pessoa_id: pessoa.id, presente: true, papeis: [], pode_propor: false };
        p.presente = true;
        if (pessoa.id === presidente.pessoa_id) p.papeis.push('PRESIDENTE');
        if (pessoa.id === v.secretario_id) p.papeis.push('SECRETARIO');
        participantes.set(pessoa.id,p);
      }
      for (const p of participantes.values()) if (!p.papeis.length) p.papeis.push('PARTICIPANTE');
      const pastor = oficiais.find(o => o.id === institucional);
      if (v.motivo === 'AUSENCIA' && pastor && participantes.get(pastor.pessoa_id)?.presente)
        throw new BadRequestException('O presidente institucional consta como presente. Confira o motivo da indicação.');
      let criterio = v.criterio_presidencia;
      if (!criterio && anterior?.criterio_presidencia && anterior.presidente_oficial_id === presidente.id)
        criterio = regencia.parse(anterior.criterio_presidencia);
      if (!criterio && (anterior?.criterio_presidencia || (v.motivo !== 'PRESIDENCIA_INSTITUCIONAL' && presidente.prioridade !== 1)))
        throw new BadRequestException('Registre a ordem de presidência e os impedimentos da sessão.');
      if (criterio) {
        const impedidos = new Map(criterio.impedimentos.map(i => [i.oficial_id, i]));
        const anteriores = oficiais.filter(o => o.id !== presidente.id && o.prioridade !== null && o.prioridade < (presidente.prioridade ?? 4));
        if (impedidos.size !== criterio.impedimentos.length || criterio.impedimentos.some(i => {
          const candidato = anteriores.find(o => o.id === i.oficial_id);
          return !candidato || (i.motivo === 'AUSENTE' && participantes.get(candidato.pessoa_id)?.presente);
        })) throw new BadRequestException('Confira as ausências e impedimentos na ordem de presidência.');
        if (!criterio.determinacao_presbiterio && (presidente.prioridade === null || anteriores.some(o => !impedidos.has(o.id))))
          throw new BadRequestException('Comprove as substituições pela ordem. Se todos estiverem impedidos, reagende ou registre a determinação do Presbitério.');
      }
      if (!anterior && v.votantes_confirmados === undefined)
        throw new BadRequestException('Confira o direito a voto na instalação. Informe a relação de votantes, que pode estar vazia.');
      const votantes = v.votantes_confirmados ?? (Array.isArray(anterior?.votantes_confirmados) ? anterior.votantes_confirmados as string[] : undefined);
      if (votantes) {
        const rol = await this.rol(tx, a.igreja_id, rd.data);
        const aptos = new Set(rol.filter(p => p.categoria === 'COMUNGANTES').map(p => p.pessoa_id));
        if (new Set(votantes).size !== votantes.length || votantes.some(id => !aptos.has(id)))
          throw new BadRequestException('Confira a relação de votantes no rol comungante da data da sessão.');
      }
      const total = [...participantes.values()].filter(p => p.presente).length;
      if (v.universo < total) throw new BadRequestException('Confira o universo informado para esta assembleia.');
      if (rd.modelo_reuniao) {
        const apuracao = conferirVotacao({votantes_confirmados:votantes},[...participantes.values()],0,false);
        const quorum = quorumDoModelo(rd,{universo:v.universo,habilitados_presentes:apuracao.votantes_presentes?.length ?? 0});
        if (!quorum?.atingido) throw new BadRequestException('O quórum previsto para esta convocação ainda não foi atingido.');
        v.quorum={minimo:quorum.minimo,competencia:rd.modelo_reuniao.finalidade,fundamento:rd.modelo_reuniao.configuracao.fundamentacao};
      }
      if (v.quorum) conferirVotacao({ votantes_confirmados: votantes }, [...participantes.values()], v.quorum.minimo, true);
      const quorumPreservado = v.votantes_confirmados === undefined && rd.quorum_conferido && rd.universo_informado === v.universo && total === rd.participantes.filter(p => p.presente).length;
      const novos = dto.validar(dto.reuniaoDadosSchema, { ...rd, inicio: rd.inicio ?? desde.toISOString(), situacao: 'EM_ANDAMENTO',
        universo_informado: v.universo, quorum_conferido: !!v.quorum || quorumPreservado,
        ...(v.quorum && { quorum_minimo: v.quorum.minimo, competencia: v.quorum.competencia, fundamento_quorum: v.quorum.fundamento }), participantes: [...participantes.values()] });
      await this.cadastros.conferirConvocacao(tx,a,r.contexto_id,novos,id,rd);
      await tx.reuniao.update({ where: { id }, data: { dados: json(novos), instalacao_formal: true, revisao: { increment: 1 } } });
      await this.cadastros.participantes(tx,a,r,novos);
      const mesa = await tx.mesa_assembleia.create({ data: { igreja_id: a.igreja_id, contexto_id: r.contexto_id, reuniao_id: id,
        ordem: (anterior?.ordem ?? 0) + 1, presidente_oficial_id: presidente.id, secretario_id: v.secretario_id,
        presidente_nome: presidente.nome, secretario_nome: pessoas.find(p => p.id === v.secretario_id)!.nome_completo,
        registrada_por: a.sub, vigente_desde: desde, motivo: v.motivo, fundamento: v.fundamento,
        ...(criterio && { criterio_presidencia: json(criterio) }), ...(votantes && { votantes_confirmados: json(votantes) }) }, include: incluirOficialMesa });
      await tx.acesso_assembleia.updateMany({ where: { ...escopoMesa(r), mesa_id: { not: mesa.id }, revogado_em: null },
        data: { revogado_em: new Date() } });
      await this.atualizarMinutas(tx, await this.cadastros.reuniao(tx,a,id), mesa);
      return { id: mesa.id, revisao: r.revisao + 1 };
    }, async tx => { await this.exigir(tx,a,id,'instalar'); });
  }

  private async atualizarMinutas(tx: Tx, r: Reuniao, mesa: Parameters<typeof aplicarMesa>[1]) {
    const versoes = await tx.documento_versao.findMany({ where: { reuniao_id: r.id, igreja_id: r.igreja_id, congelado_em: null,
      documento: { tipo: 'ATA', estado: 'EM_EDICAO' } }, include: { modelo: true, documento: { select: { versao_atual: true } } } });
    for (const versao of versoes) {
      if (!versao.modelo || versao.numero !== versao.documento.versao_atual) continue;
      const config = dto.configuracaoSchema.parse(versao.modelo.configuracao);
      const conteudo = dto.conteudoSchema.parse(versao.conteudo);
      aplicarMesa(conteudo, mesa, config);
      // Atualizar apenas os campos originários da sessão. O edital e os valores recepcionados conservam seus retratos.
      const definicoes = Object.fromEntries(Object.entries(config.definicoes ?? {}).filter(([id,d]) =>
        ['nome_presidente_mesa','nome_secretario_mesa','redator_ata','presentes'].includes(d.origem) && conteudo.valores?.[id]?.origem.tipo !== 'documento_anterior'));
      const entrada: dto.VersaoInput = { modelo_versao_id: versao.modelo.id, reuniao_id: r.id, motivador_id: null, assunto: versao.assunto,
        data_documento: versao.data_documento.toISOString().slice(0,10), conteudo: { ...conteudo, composicao: undefined, valores: {} } };
      await prepararCampos(tx,r.igreja_id,{ ...config, definicoes },entrada,{ reuniao: r, previsto: false },{},null);
      conteudo.valores = { ...conteudo.valores, ...entrada.conteudo.valores };
      const existentes = await tx.arrolado_documento.findMany({ where: { versao_id: versao.id }, select: { pessoa_id: true, papeis: true } });
      const afetados = new Set([mesa.oficial.pessoa_id, mesa.secretario_id, ...existentes.filter(p => p.papeis.some(ehPapelMesa)).map(p => p.pessoa_id)]);
      for (const p of conteudo.arrolados.filter(p => afetados.has(p.pessoa_id))) {
        const flags = { papeis: p.papeis, assina: p.assina, obrigatorio: p.obrigatorio, responsavel: p.responsavel };
        const pessoa = await tx.pessoas.findUniqueOrThrow({ where: { id: p.pessoa_id }, select: { nome_completo: true, email: true } });
        await tx.arrolado_documento.upsert({ where: { versao_id_pessoa_id: { versao_id: versao.id, pessoa_id: p.pessoa_id } }, update: flags,
          create: { ...flags, versao_id: versao.id, igreja_id: r.igreja_id, contexto_id: r.contexto_id, pessoa_id: p.pessoa_id,
            retrato: { nome: pessoa.nome_completo, email: pessoa.email, cargos: [], cargo: null, fundamento: p.fundamento } } });
      }
      await tx.documento_versao.update({ where: { id: versao.id }, data: { conteudo: json(conteudo), revisao_conteudo: { increment: 1 } } });
      await tx.documento.update({ where: { id: versao.documento_id }, data: { encaminhado_em: null, revisao: { increment: 1 } } });
    }
  }
}
