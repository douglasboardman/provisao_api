import { permissoesAtas } from './sigilo-ata';
import { contextosDasAtasRestritas, filtroVisibilidadeDocumentos } from './visibilidade-documentos';
import { periodoOrgao } from '../orgaos/acesso-sociedades';
import { comparar, decidirAcaoModelo, papeisDaConta } from '../autorizacao/politica';
import { contextoPorExtenso } from './contexto-por-extenso';
import { ehPapelMesa, conferirVotacao, mesaVigente } from './mesa-assembleia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { opcoesAtuacao, validarAtuacao, permissoesModelo } from './atuacao-modelo.service';
import { createHash, randomUUID } from 'node:crypto';
import { horariosDaReuniao } from './horario-reuniao';
import { dataReuniaoPorExtenso } from './data-reuniao';
import { localSchema, retratoLocal } from './local-reuniao';
import { z } from 'zod';
import { editorPaginaHabilitado, exigirEditorPagina } from './liberacao-editor';
import { validarEncadeamento } from './encadeamento';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SecretariaBaseService, AtorSecretaria, Tx, dataCivil, json } from './secretaria-base.service';
import { ocorrencias } from './composicao-pagina';
import * as dto from './secretaria.dto';
import { arquivoSemVinculoDeExpedicao, PrivateStorageService } from '../private-storage/private-storage.service';
import { bytesLogoDocumental, decodificarImagemDocumental, limitePixelsDocumento } from './imagens-documentais';

async function fusoDaReuniao(tx: Tx, igreja_id: string) {
  const config = await tx.configuracao_fuso_igreja.findUnique({ where: { igreja_id }, select: { fuso_iana: true } });
  return config?.fuso_iana;
}

function comDataHora<T extends { data: Date; dados: Prisma.JsonValue }>(reuniao: T, fuso?: string) {
  const dados = reuniao.dados;
  const horarios: Prisma.JsonObject = dados && typeof dados === 'object' && !Array.isArray(dados) ? dados : {};
  return { ...reuniao, ...dataReuniaoPorExtenso(reuniao.data), ...horariosDaReuniao(horarios.inicio, horarios.fim, fuso) };
}

export function planejamentoDaReuniao(reuniao: { dados: Prisma.JsonValue; local_id: string | null; local_retrato: Prisma.JsonValue; itens_pauta: { descricao: string; proponente_id: string | null }[] }) {
  const dados = reuniao.dados as unknown as dto.ReuniaoInput;
  const local = reuniao.local_retrato as ReturnType<typeof retratoLocal> | null;
  return createHash('sha256').update(JSON.stringify([dados.modalidade, dados.data, dados.horario_previsto, reuniao.local_id, dados.local, local?.endereco_extenso, local?.endereco_declarativo,
    reuniao.itens_pauta.map(i => [i.descricao, i.proponente_id])])).digest('hex');
}

const incluirReuniao = {
  participantes: true,
  itens_pauta: { orderBy: { ordem: 'asc' }, select: {
    id: true, ordem: true, descricao: true, proponente_id: true, proponente: { select: { nome_completo: true } },
  } },
} satisfies Prisma.reuniaoInclude;

@Injectable()
export class SecretariaCadastrosService {
  constructor(readonly base: SecretariaBaseService, private readonly storage: PrivateStorageService) {}

  async admin(tx: Tx, a: AtorSecretaria) {
    if ((await this.base.operador(tx, a)).perfil !== 'ADMINISTRADOR') throw new ForbiddenException('Configuração técnica reservada ao administrador.');
  }

  criarContexto(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.contextoSchema, dados);
    return this.base.comando(a, 'CRIAR_CONTEXTO', null, v, async tx => {
      await this.admin(tx, a);
      if ((v.tipo === 'ORGAO') !== !!v.orgao_id) throw new BadRequestException('Órgão obrigatório apenas no contexto de órgão.');
      const orgao = v.orgao_id ? await tx.orgao_interno.findFirst({ where: { id: v.orgao_id, igreja_id: a.igreja_id } }) : null;
      if (orgao?.tipo === 'ASSEMBLEIA_GERAL') throw new BadRequestException('Use o contexto da Assembleia Geral.');
      if (v.orgao_id && !orgao) throw new NotFoundException('Órgão não encontrado.');
      const anterior = await tx.contexto_secretaria.findFirst({ where: { igreja_id: a.igreja_id, tipo: v.tipo, orgao_id: v.orgao_id } });
      if (anterior) return { id: anterior.id };
      const c = await tx.contexto_secretaria.create({ data: { igreja_id: a.igreja_id, tipo: v.tipo, orgao_id: v.orgao_id, nome: orgao?.nome ?? v.nome, sigla: orgao?.sigla ?? v.sigla } });
      return { id: c.id };
    });
  }

  resumoContexto(a: AtorSecretaria, contexto_id: string) {
    return this.base.prisma.$transaction(async tx => {
      const { somenteAtas } = await this.base.contextoDeAtas(tx, a, contexto_id);
      const restritos = (await this.base.concessoes(tx, a, contexto_id)).some(c => c.pode_consultar_restritos);
      const recorte = { igreja_id: a.igreja_id, contexto_id };
      const where = { ...recorte, ...(somenteAtas && { tipo: 'ATA' as const }), ...filtroVisibilidadeDocumentos(restritos, await contextosDasAtasRestritas(tx,a.igreja_id,a.sub)) };
      const [documentos, atas, em_edicao, reunioes] = await Promise.all([
        tx.documento.count({ where }), tx.documento.count({ where: { ...where, tipo: 'ATA' } }),
        tx.documento.count({ where: { ...where, estado: 'EM_EDICAO' } }), somenteAtas ? 0 : tx.reuniao.count({ where: { ...recorte, ...(!restritos && { restrito: false }) } }),
      ]);
      return { documentos, atas, em_edicao, reunioes };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async convocacaoEmCurso(tx: Tx, a: AtorSecretaria, contexto: string, reuniao: string, apenasPublicos = false) {
    const candidatas = await tx.documento_versao.findMany({
      where: { igreja_id: a.igreja_id, contexto_id: contexto, reuniao_id: reuniao, modelo: { finalidade: 'CONVOCACAO' }, documento: { ...(apenasPublicos ? { restrito: false } : {}), estado: { in: ['EM_EDICAO','APROVADO'] } } },
      select: { id: true, modelo: { select: { configuracao: true } }, numero: true, modelo_versao_id: true, documento: { select: { id: true, revisao: true, restrito: true, estado: true, versao_atual: true } } },
    });
    return candidatas.find(v => v.numero === v.documento.versao_atual);
  }

  consultarReuniao(a: AtorSecretaria, id: string) {
    return this.base.prisma.$transaction(async tx => {
      const usuario = await this.base.operador(tx, a);
      const r = await this.reuniao(tx, a, id);
      const restritos = (await this.base.concessoes(tx, a, r.contexto_id)).some(c => c.pode_consultar_restritos);
      const editais = await tx.documento_versao.findMany({
        where: { reuniao_id: id, igreja_id: a.igreja_id, modelo: { finalidade: 'CONVOCACAO' },
          expedicao: { estado: 'CONCLUIDA' }, documento: restritos ? {} : { restrito: false } },
        select: { id: true, documento_id: true, assunto: true, conteudo: true, fonte_congelada: true, numero: true },
        orderBy: { expedicao: { expedido_em: 'desc' } },
      });
      const planejamentoAtual = planejamentoDaReuniao(r);
      const emCurso = await this.convocacaoEmCurso(tx, a, r.contexto_id, r.id, !restritos);
      let podeEditar = false;
      if (usuario.perfil !== 'COMUM' && emCurso?.documento.estado === 'EM_EDICAO' && await this.base.podePreparar(tx, a, r.contexto_id, usuario)) {
        const regra = dto.configuracaoSchema.parse(emCurso.modelo?.configuracao).atuacao;
        const papeis = await this.base.atuacao.papeis(tx, await this.base.contexto(tx, a, r.contexto_id), usuario.pessoa_id);
        const permissoes = permissoesModelo(regra, papeis);
        podeEditar = !regra || permissoes.criar || permissoes.preparar;
      }
      const mesa = r.instalacao_formal ? await mesaVigente(tx, r) : null;
      return { ...r, mesa_atual_id: mesa?.id ?? null, convocacao_em_curso: emCurso ? { documento_id: emCurso.documento.id, versao_id: emCurso.id, pode_editar: podeEditar } : null,
        convocacoes: editais.map(edital => {
        const fonte = (edital.fonte_congelada as { reuniao?: typeof r } | null)?.reuniao;
        return { versao_id: edital.id, documento_id: edital.documento_id, assunto: edital.assunto,
          versao: edital.numero, agendamento_alterado: (edital.conteudo as dto.VersaoInput['conteudo']).planejamento_origem ? (edital.conteudo as dto.VersaoInput['conteudo']).planejamento_origem !== planejamentoAtual : fonte?.itens_pauta ? planejamentoDaReuniao(fonte) !== planejamentoAtual : null };
      }) };
    });
  }

  async listarContextos(a: AtorSecretaria) {
    return this.base.prisma.$transaction(async tx => {
      const u = await this.base.operador(tx, a, true);
      const acessoAtas = await permissoesAtas(tx, a.igreja_id, u.pessoa_id);
      const concessoes = await this.base.concessoes(tx, a);
      const contextos = await tx.contexto_secretaria.findMany({ where: { igreja_id: a.igreja_id }, include: { igreja: { select: { nome: true } }, orgao: { select: { nome: true, sigla: true, tipo: true, constituicao: true, ativo: true, tipo_padrao: true, gestao_presidencial: true } } }, orderBy: { orgao: { nome: 'asc' } } });
      const visiveis = (await Promise.all(contextos.map(async c => ({ c, visivel: await this.base.contextoVisivel(tx, c, u) })))).filter(x => x.visivel || acessoAtas.get(x.c.id)?.ler);
      return Promise.all(visiveis.map(async ({ c: { igreja, ...c }, visivel }) => {
        const grants = visivel ? concessoes.filter(g => g.contexto_id === c.id) : [];
        const podePreparar = visivel && c.orgao.ativo && (['GESTOR','SECRETARIO'].includes(u.perfil) || (u.perfil === 'COMUM' && (await this.base.papeisContextuais(tx, c, u)).size > 0) || (u.perfil !== 'AUDITOR' && grants.some(g => g.pode_aprovar || g.pode_deliberar)));
        return { ...c, somente_atas: !visivel, pode_classificar_ata: !!acessoAtas.get(c.id)?.classificar, ...((!visivel || u.perfil === 'COMUM') && { registro_livro: false }), nome: c.orgao.nome, sigla: c.orgao.sigla ?? c.sigla, por_extenso: contextoPorExtenso(c.orgao.nome, igreja.nome), editor_pagina: editorPaginaHabilitado(c.id), pode_preparar: podePreparar,
          pode_instalar_mesa: c.orgao.ativo && c.tipo === 'ASSEMBLEIA_GERAL' && u.perfil !== 'AUDITOR' && grants.some(g => g.pode_instalar_mesa),
          pode_agendar: u.perfil !== 'COMUM' && podePreparar && await this.base.atuacao.podeAgendar(tx, c, u.pessoa_id),
          pode_aprovar: c.orgao.ativo && u.perfil !== 'AUDITOR' && !!u.pessoa_id && grants.some(g => g.pode_aprovar),
          pode_deliberar: c.orgao.ativo && u.perfil !== 'AUDITOR' && !!u.pessoa_id && grants.some(g => g.pode_deliberar),
          pode_consultar_restritos: grants.some(g => g.pode_consultar_restritos) };
      }));
    });
  }

  conceder(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.competenciaSchema, dados);
    return this.base.comando(a, 'CONCEDER_COMPETENCIA', v.contexto_id, v, async tx => {
      await this.admin(tx, a);
      const contexto = await this.base.contexto(tx, a, v.contexto_id);
      if (v.pode_instalar_mesa && contexto.tipo !== 'ASSEMBLEIA_GERAL') throw new BadRequestException('Instalação de mesa exige o contexto da Assembleia Geral.');
      const titular = await tx.usuarios.findFirst({ where: { id: v.usuario_id, igreja_id: a.igreja_id, ativo: true } });
      if (!titular || !titular.pessoa_id || !['ADMINISTRADOR', 'GESTOR', 'SECRETARIO', 'AUDITOR', 'COMUM'].includes(titular.perfil) || (titular.perfil === 'AUDITOR' && (v.pode_aprovar || v.pode_deliberar || v.pode_instalar_mesa))) throw new BadRequestException('Titular exige pessoa vinculada e perfil compatível.');
      if (titular.perfil === 'COMUM') {
        const admin = await this.base.operador(tx, a);
        if (!admin.pessoa_id || admin.pessoa_id === titular.pessoa_id) throw new ForbiddenException('Outra pessoa identificada deve conceder esta competência.');
      }
      const { inicio, fim } = v;
      const data = { contexto_id: v.contexto_id, usuario_id: v.usuario_id, pode_instalar_mesa: v.pode_instalar_mesa, pode_aprovar: v.pode_aprovar, pode_deliberar: v.pode_deliberar, pode_consultar_restritos: v.pode_consultar_restritos, autoridade: v.autoridade, evidencia: v.evidencia };
      const c = await tx.competencia_secretaria.create({ data: { ...data, igreja_id: a.igreja_id, pessoa_id: titular.pessoa_id, geracao_vinculo: titular.perfil === 'COMUM' ? titular.geracao_vinculo : null, registrado_por_id: a.sub, inicio: dataCivil(inicio), fim: fim ? dataCivil(fim) : null } });
      return { id: c.id };
    });
  }

  encerrarCompetencia(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.fimCompetenciaSchema, dados);
    return this.base.comando(a, 'ENCERRAR_COMPETENCIA', id, v, async tx => {
      await this.admin(tx, a);
      const c = await tx.competencia_secretaria.findFirst({ where: { id, igreja_id: a.igreja_id } });
      if (!c) throw new NotFoundException('Competência não encontrada.');
      if (c.fim || dataCivil(v.fim) < c.inicio) throw new BadRequestException('Período encerrado ou inválido.');
      await tx.competencia_secretaria.update({ where: { id }, data: { fim: dataCivil(v.fim) } });
      return { id };
    });
  }

  async listarCompetencias(a: AtorSecretaria) {
    return this.base.prisma.$transaction(async tx => {
      await this.admin(tx, a);
      return tx.competencia_secretaria.findMany({ where: { igreja_id: a.igreja_id }, include: { titular: { select: { nome_usuario: true } } }, orderBy: { criado_em: 'desc' }, take: 200 });
    });
  }

  async listarLocais(a: AtorSecretaria) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      const locais = await tx.local_reuniao.findMany({ where: { igreja_id: a.igreja_id }, orderBy: [{ descritivo: 'asc' }, { id: 'asc' }] });
      return locais.map(local => ({ ...local, ...retratoLocal(local) }));
    });
  }

  salvarLocal(a: AtorSecretaria, dados: unknown, id?: string) {
    const schema = z.strictObject({ ...dto.chave, local: localSchema });
    const v = dto.validar(id ? schema.extend(dto.revisao) : schema, dados);
    return this.base.comando(a, id ? 'LOCAL_EDITAR' : 'LOCAL_CRIAR', id ?? null, v, async tx => {
      if (id) {
        const anterior = await tx.local_reuniao.findFirst({ where: { id, igreja_id: a.igreja_id } });
        if (!anterior) throw new NotFoundException('Local de reunião não encontrado.');
        this.base.conferirRevisao(anterior.revisao, dto.validar(schema.extend(dto.revisao), dados).revisao);
        return tx.local_reuniao.update({ where: { id }, data: { ...v.local, revisao: { increment: 1 } }, select: { id: true, revisao: true } });
      }
      return tx.local_reuniao.create({ data: { igreja_id: a.igreja_id, ...v.local }, select: { id: true, revisao: true } });
    });
  }

  private async localParaReuniao(tx: Tx, igreja_id: string, id: string | undefined, nome: string,
    anterior?: { local_id: string | null; dados: Prisma.JsonValue }) {
    const anteriorNome = (anterior?.dados as { local?: string } | undefined)?.local;
    if (anterior && (id ? id === anterior.local_id : nome === anteriorNome))
      return { nome: anteriorNome!, vinculo: {} };
    if (!id) return { nome, vinculo: { local_id: null, local_retrato: Prisma.DbNull } };
    const local = await tx.local_reuniao.findFirst({ where: { id, igreja_id } });
    if (!local) throw new BadRequestException('Local de reunião indisponível nesta igreja.');
    return { nome: local.descritivo, vinculo: { local_id: local.id, local_retrato: retratoLocal(local) } };
  }

  listarCampos(a: AtorSecretaria) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      return tx.campo_secretaria.findMany({ where: { igreja_id: a.igreja_id }, orderBy: [{ nome: 'asc' }, { id: 'asc' }] });
    });
  }

  salvarCampo(a: AtorSecretaria, dados: unknown, id?: string) {
    const v = id ? dto.validar(dto.editarCampoSchema, dados) : dto.validar(dto.criarCampoSchema, dados);
    const definicao = dto.definicaoCampo.parse({ nome: v.nome, tipo: v.tipo, multiplo: v.multiplo, origem: v.origem });
    if (v.origem !== 'manual' && (v.multiplo !== (['presentes', 'pauta_reuniao', 'deliberacoes_reuniao'].includes(v.origem)) || v.tipo !== (['numero_documento','numero_livro','capacidade_folhas_livro'].includes(v.origem) ? 'numero' : ['data_documento','data_prevista_reuniao'].includes(v.origem) ? 'data' : 'texto'))) {
      throw new BadRequestException('Tipo ou multiplicidade incompatível com a origem.');
    }
    return this.base.comando(a, id ? 'CAMPO_EDITAR' : 'CAMPO_CRIAR', id ?? null, v, async tx => {
      if (!id) return tx.campo_secretaria.create({ data: { ...definicao, igreja_id: a.igreja_id } });
      const anterior = await tx.campo_secretaria.findFirst({ where: { id, igreja_id: a.igreja_id } });
      if (!anterior) throw new NotFoundException('Campo indisponível.');
      const edicao = dto.validar(dto.editarCampoSchema, dados);
      this.base.conferirRevisao(anterior.revisao, edicao.revisao);
      return tx.campo_secretaria.update({ where: { id }, data: { ...definicao, ativo: edicao.ativo, revisao: { increment: 1 } } });
    });
  }

  private async publicarCampos(tx: Tx, igreja_id: string, config: dto.ConfiguracaoModelo, contexto: string, modelo: string) {
    const usos = ocorrencias(config.composicao_padrao);
    const ids = [...new Set([...usos.map(c => c.campo_id), ...(config.obrigatorios_biblioteca ?? [])])];
    if (ids.length > 100) throw new BadRequestException('Confira os campos usados no modelo.');
    const campos = ids.length ? await tx.campo_secretaria.findMany({ where: { igreja_id, ativo: true, id: { in: ids } }, include: { mapeamento: { select: { cadastro: true, propriedade: true, transformacao: true } } } }) : [];
    if (ids.length !== campos.length) throw new BadRequestException('O modelo contém campo indisponível na biblioteca da igreja.');
    const definicoes = Object.fromEntries(campos.map(({ id, nome, tipo, multiplo, origem, mapeamento }) =>
      [id, { ...dto.definicaoCampo.parse({ nome, tipo, multiplo, origem }), mapeamento }]));
    for (const uso of usos) if (!definicoes[uso.campo_id].multiplo && (uso.apresentacao !== 'individual' || uso.indice)) throw new BadRequestException('Apresentação incompatível com o campo.');
    const publicada = { ...config, definicoes };
    await validarEncadeamento(tx, igreja_id, contexto, modelo, publicada);
    return publicada;
  }

  async configurar(tx: Tx, a: AtorSecretaria, contextoId: string, configuracao: dto.ConfiguracaoModelo) {
    const c = await this.base.contexto(tx, a, contextoId);
    if (configuracao.contexto !== c.tipo || (c.tipo === 'ORGAO' && (!configuracao.tipos_orgao.some(tipo => tipo === c.orgao.tipo) || !configuracao.constituicoes.includes(c.orgao.constituicao)))) throw new BadRequestException('Modelo não aplicável ao contexto/constituição.');
    const ids = [...new Set(configuracao.cargos_obrigatorios)];
    if (ids.length && (!c.orgao_id || await tx.cargo_orgao.count({ where: { id: { in: ids }, igreja_id: a.igreja_id, orgao_id: c.orgao_id, ativo: true } }) !== ids.length)) throw new BadRequestException('Cargo exigido inexistente neste contexto.');
  }

  private async salvarImagensModelo(tx: Tx, a: AtorSecretaria, contexto: string, modelo: string, versao: string | null, config: dto.ConfiguracaoModelo, versaoAnterior?: string) {
    const blocos = dto.imagensDaEstrutura(config.estrutura_padrao, config.composicao_padrao);
    const ids = [...new Set(blocos.map(b => b.arquivo_id))];
    const arquivos = await tx.arquivo_privado.findMany({
      where: {
        id: { in: ids }, igreja_id: a.igreja_id, artefatos_documento: { none: {} }, livros_historicos: { none: {} }, registros_livro: { none: {} },
          ...arquivoSemVinculoDeExpedicao,
        OR: [{ usuario_id: a.sub, anexos_documento: { none: { versao: { documento: { tipo: 'ATA', restrito: true } } } } }, { imagens_modelo_rascunho: { some: { modelo_id: modelo } } }, ...(versaoAnterior ? [{ imagens_modelo: { some: { versao_id: versaoAnterior } } }] : [])],
      },
    });
    const tamanho = arquivos.reduce((total, f) => total + f.tamanho * blocos.filter(b => b.arquivo_id === f.id).length, 0);
    if (ids.length !== arquivos.length || tamanho > 4 * 1024 * 1024) throw new BadRequestException('Imagens do modelo indisponíveis ou acima de 4 MB no total.');
    let totalPixels = 0;
    for (const arquivo of arquivos) {
      if (arquivo.tamanho > 2 * 1024 * 1024) throw new BadRequestException('Cada imagem do modelo deve ter até 2 MB.');
      totalPixels += decodificarImagemDocumental(await this.storage.readVerified(arquivo)).pixels * blocos.filter(b => b.arquivo_id === arquivo.id).length;
      if (totalPixels > limitePixelsDocumento) throw new BadRequestException('As imagens do modelo devem somar até 32 megapixels.');
    }
    if (!versao) {
      await tx.imagem_modelo_rascunho.deleteMany({ where: { modelo_id: modelo, arquivo_id: { notIn: ids } } });
      if (ids.length) await tx.imagem_modelo_rascunho.createMany({ skipDuplicates: true, data: ids.map(arquivo_id => ({
        modelo_id: modelo, igreja_id: a.igreja_id, contexto_id: contexto, arquivo_id,
      })) });
      return;
    }
    if (!ids.length) return;
    await tx.imagem_modelo_documento.createMany({
      data: ids.map(arquivo_id => ({ igreja_id: a.igreja_id, contexto_id: contexto, versao_id: versao, arquivo_id })),
    });
  }

  private conferirFinalidadeTermo(v: { tipo: 'ATA' | 'OUTRO'; finalidade: string; configuracao: dto.ConfiguracaoModelo }) {
    if (v.tipo !== 'ATA' && v.configuracao.assinaturas_reuniao && v.configuracao.assinaturas_reuniao !== 'CARGOS')
      throw new BadRequestException('A assinatura pela mesa ou pelos presentes exige um modelo de ata.');
    if (dto.finalidadeTermo(v.finalidade) && (v.tipo !== 'OUTRO' || dto.politicaLivro(v.configuracao) !== 'NAO_PERMITE')) {
      throw new BadRequestException('Use tipo OUTRO e vinculação própria para termos de abertura e encerramento.');
    }
  }

  criarModelo(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.modeloSchema, dados);
    this.conferirFinalidadeTermo(v);
    return this.base.comando(a, 'CRIAR_MODELO', v.contexto_id, v, async tx => {
      const u = await this.base.operador(tx, a);
      await this.base.contextoAtivo(tx, a, v.contexto_id);
      if (u.perfil !== 'ADMINISTRADOR') await this.base.preparar(tx, a, v.contexto_id);
      if (v.configuracao.composicao_padrao) exigirEditorPagina(v.contexto_id);
      await this.configurar(tx, a, v.contexto_id, v.configuracao);
      validarAtuacao(v.configuracao.atuacao, await opcoesAtuacao(tx, await this.base.contexto(tx, a, v.contexto_id)), !!v.publicar);
      const m = await tx.modelo_documento.create({ data: { igreja_id: a.igreja_id, contexto_id: v.contexto_id, nome: v.nome } });
      const campos = { igreja_id: a.igreja_id, contexto_id: m.contexto_id, modelo_id: m.id, tipo: v.tipo, finalidade: v.finalidade,
        configuracao: json(await this.publicarCampos(tx, a.igreja_id, v.configuracao, m.contexto_id, m.id)) };
      if (v.publicar) {
        const versao = await tx.modelo_documento_versao.create({ data: { ...campos, numero: 1 } });
        await this.salvarImagensModelo(tx, a, m.contexto_id, m.id, versao.id, v.configuracao);
        return { id: m.id, versao_id: versao.id, revisao: 1, estado: 'PUBLICADO' };
      }
      await tx.modelo_documento_rascunho.create({ data: { ...campos, nome: m.nome } });
      await this.salvarImagensModelo(tx, a, m.contexto_id, m.id, null, v.configuracao);
      return { id: m.id, revisao: 1, estado: 'EM_EDICAO' };
    });
  }

  private async modeloParaEditar(tx: Tx, a: AtorSecretaria, id: string, revisao: number) {
    const m = await tx.modelo_documento.findFirst({ where: { id, igreja_id: a.igreja_id },
      include: { rascunho: true, versoes: { orderBy: { numero: 'desc' }, take: 1 } } });
    if (!m) throw new NotFoundException('Modelo não encontrado.');
    const u = await this.base.operador(tx, a);
    await this.base.contextoAtivo(tx, a, m.contexto_id);
    if (u.perfil !== 'ADMINISTRADOR') await this.base.preparar(tx, a, m.contexto_id);
    this.base.conferirRevisao(m.revisao, revisao);
    return m;
  }

  iniciarEdicaoModelo(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(z.strictObject({ ...dto.chave, ...dto.revisao }), dados);
    return this.base.comando(a, 'EDITAR_MODELO', id, v, async tx => {
      const m = await this.modeloParaEditar(tx, a, id, v.revisao);
      if (m.rascunho) return { id, revisao: m.revisao };
      const ultima = m.versoes[0];
      if (!ultima) throw new ConflictException('Modelo sem versão para editar.');
      await tx.modelo_documento_rascunho.create({ data: { modelo_id: id, igreja_id: a.igreja_id, contexto_id: m.contexto_id,
        nome: m.nome, tipo: ultima.tipo, finalidade: ultima.finalidade, configuracao: json(ultima.configuracao) } });
      const imagens = await tx.imagem_modelo_documento.findMany({ where: { versao_id: ultima.id }, select: { arquivo_id: true } });
      if (imagens.length) await tx.imagem_modelo_rascunho.createMany({ data: imagens.map(i => ({
        ...i, modelo_id: id, igreja_id: a.igreja_id, contexto_id: m.contexto_id,
      })) });
      await tx.modelo_documento.update({ where: { id }, data: { revisao: { increment: 1 } } });
      return { id, revisao: m.revisao + 1 };
    });
  }

  salvarModelo(a: AtorSecretaria, id: string, dados: unknown, acao: 'rascunho' | 'publicar' | 'versionar') {
    const v = dto.validar(dto.modeloVersaoSchema, dados);
    this.conferirFinalidadeTermo(v);
    return this.base.comando(a, { rascunho: 'SALVAR_RASCUNHO_MODELO', publicar: 'PUBLICAR_MODELO', versionar: 'VERSIONAR_MODELO' }[acao], id, v, async tx => {
      const m = await this.modeloParaEditar(tx, a, id, v.revisao);
      if (!m.rascunho && acao !== 'versionar') throw new ConflictException('Abra o modelo para edição antes de salvar ou publicar.');
      if (m.rascunho && acao === 'versionar') throw new ConflictException('O modelo está em edição. Publique o rascunho.');
      const ultima = m.versoes[0];
      const base = m.rascunho ?? ultima;
      if (v.configuracao.composicao_padrao && (!base || !dto.validar(dto.configuracaoSchema, base.configuracao).composicao_padrao)) exigirEditorPagina(m.contexto_id);
      await this.configurar(tx, a, m.contexto_id, v.configuracao);
      validarAtuacao(v.configuracao.atuacao, await opcoesAtuacao(tx, await this.base.contexto(tx, a, m.contexto_id)), acao !== 'rascunho');
      const campos = { tipo: v.tipo, finalidade: v.finalidade, configuracao: json(await this.publicarCampos(tx, a.igreja_id, v.configuracao, m.contexto_id, id)) };
      const nome = v.nome ?? m.rascunho?.nome ?? m.nome;
      let versao_id: string | undefined;
      if (acao === 'rascunho') {
        await tx.modelo_documento_rascunho.update({ where: { modelo_id: id }, data: { ...campos, nome } });
        await this.salvarImagensModelo(tx, a, m.contexto_id, id, null, v.configuracao, ultima?.id);
      } else {
        const publicada = await tx.modelo_documento_versao.create({ data: { ...campos, modelo_id: id, igreja_id: a.igreja_id,
          contexto_id: m.contexto_id, numero: (ultima?.numero ?? 0) + 1 } });
        versao_id = publicada.id;
        await this.salvarImagensModelo(tx, a, m.contexto_id, id, versao_id, v.configuracao, ultima?.id);
        if (m.rascunho) await tx.modelo_documento_rascunho.delete({ where: { modelo_id: id } });
      }
      await tx.modelo_documento.update({ where: { id }, data: { ...(versao_id && { nome }), revisao: { increment: 1 } } });
      return { id, versao_id, revisao: m.revisao + 1, estado: versao_id ? 'PUBLICADO' : 'EM_EDICAO' };
    });
  }

  async opcoesAtuacao(a: AtorSecretaria, contexto: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      return opcoesAtuacao(tx, await this.base.contexto(tx, a, contexto));
    });
  }

  pessoasDoContexto(a: AtorSecretaria, contexto: string) {
    return this.base.prisma.$transaction(async tx => {
      const c = await this.base.contexto(tx, a, contexto);
      const dia = await hojeDaIgreja(tx, a.igreja_id);
      let ids: string[];
      if (c.orgao.tipo === 'SOCIEDADE_INTERNA' || c.orgao.gestao_presidencial) {
        const escopo = { igreja_id: a.igreja_id, orgao_id: c.orgao_id, ...periodoOrgao(dataCivil(dia)) };
        const [membros, titulares] = await Promise.all([
          tx.membro_orgao.findMany({ where: escopo, select: { pessoa_id: true } }),
          tx.ocupacao_cargo.findMany({ where: { ...escopo, cargo: { ativo: true },
            AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: dataCivil(dia) } }] }],
          }, select: { pessoa_id: true } }),
        ]);
        ids = [...new Set([...membros, ...titulares].map(p => p.pessoa_id))];
      } else {
        if (!['CONSELHO','JUNTA','ASSEMBLEIA_GERAL'].includes(c.orgao.tipo)) return [];
        const { membros } = await this.base.atuacao.composicaoDoOrgao(tx, c, dia);
        ids = membros.map(m => m.pessoa_id);
      }
      return tx.pessoas.findMany({ where: { igreja_id: a.igreja_id, id: { in: ids } },
        select: { id: true, nome_completo: true }, orderBy: { nome_completo: 'asc' } });
    }, { isolationLevel: 'RepeatableRead' });
  }

  async cargos(a: AtorSecretaria, contexto: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      const c = await this.base.contexto(tx, a, contexto);
      return c.orgao_id ? tx.cargo_orgao.findMany({ where: { igreja_id: a.igreja_id, orgao_id: c.orgao_id, ativo: true }, select: { id: true, nome: true }, orderBy: { nome: 'asc' } }) : [];
    });
  }

  enviarImagem(a: AtorSecretaria, bytes: Buffer, idempotencia: string) {
    const dados = { idempotencia, sha256: createHash('sha256').update(bytes).digest('hex') };
    const arquivoId = randomUUID();
    return this.base.comando(a, 'ENVIAR_IMAGEM', null, dados, async tx => {
      const arquivo = await this.storage.saveArtifact(tx, a, arquivoId, bytes);
      return { id: arquivo.id, tamanho: arquivo.tamanho };
    });
  }

  async logoDaIgreja(a: AtorSecretaria) {
    const igreja = await this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      return tx.igreja.findUniqueOrThrow({ where: { id: a.igreja_id }, select: { url_logo: true } });
    });
    const bytes = await bytesLogoDocumental(igreja.url_logo);
    if (!bytes) throw new NotFoundException('Logo da igreja indisponível.');
    return bytes;
  }

  async imagemModelo(a: AtorSecretaria, versao: string, arquivo: string, rascunho = false) {
    const imagem = await this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      const vinculo = rascunho ? await tx.imagem_modelo_rascunho.findFirst({ where: { modelo_id: versao, arquivo_id: arquivo, igreja_id: a.igreja_id }, include: { arquivo: true } }) : await tx.imagem_modelo_documento.findFirst({ where: { versao_id: versao, arquivo_id: arquivo, igreja_id: a.igreja_id }, include: { arquivo: true } });
      if (!vinculo) throw new NotFoundException('Imagem não encontrada nesta versão.');
      await this.base.contexto(tx, a, vinculo.contexto_id);
      if (a.perfil === 'COMUM' && !await tx.modelo_documento_versao.findFirst({ where: { id: versao, igreja_id: a.igreja_id, modelo: { rascunho: null } }, select: { id: true } }))
        throw new NotFoundException('Versão indisponível.');
      return vinculo.arquivo;
    });
    return this.storage.readAuthorized(a, imagem);
  }

  async listarModelos(a: AtorSecretaria, contexto: string) {
    return this.base.prisma.$transaction(async tx => {
      const c = await this.base.contexto(tx, a, contexto);
      const u = await this.base.operador(tx, a);
      const modelos = await tx.modelo_documento.findMany({ where: { igreja_id: a.igreja_id, contexto_id: contexto }, include: { rascunho: true, versoes: { orderBy: { numero: 'desc' } } }, orderBy: { nome: 'asc' } });
      const habilitado = await this.base.podePreparar(tx, a, contexto, u);
      const dia = await hojeDaIgreja(tx, a.igreja_id);
      const exercicio = await this.base.atuacao.papeis(tx, c, (habilitado || u.conta_atuacao) ? u.pessoa_id : null, dia);
      const papeis = habilitado ? exercicio : new Set<string>();
      const proposta = await papeisDaConta(tx, u, exercicio, dia);
      const papeisComuns = u.perfil === 'COMUM' ? await this.base.papeisContextuais(tx, c, u, dia) : null;
      const visiveis = u.perfil === 'COMUM' ? modelos.filter(m => !m.rascunho && m.versoes.length).map(m => ({ ...m, versoes: m.versoes.slice(0,1) })) : modelos;
      return Promise.all(visiveis.map(async m => {
        const versao = m.versoes[0];
        const config = dto.configuracaoSchema.safeParse(versao?.configuracao);
        const regra = !m.rascunho && config.success ? config.data.atuacao : undefined;
        const permissoes = permissoesModelo(regra, papeis);
        if (papeisComuns) {
          const operacoes = permissoesModelo(regra, papeisComuns);
          return { ...m, permissoes: c.orgao.tipo === 'ASSEMBLEIA_GERAL' ? { criar: false, preparar: m.versoes[0].tipo === 'ATA' && operacoes.preparar } : operacoes, estado: 'PUBLICADO' };
        }
        for (const acao of ['criar','preparar'] as const) {
          await comparar(tx, u, 'MODELO_' + acao.toUpperCase(), versao?.id ?? m.id, permissoes[acao],
            decidirAcaoModelo(acao, regra, proposta), 'PERFIL_COMPETENCIA_E_MODELO');
        }
        return { ...m, permissoes: { ...permissoes, ...(!u.pessoa_id && { sem_pessoa_vinculada: true }) }, estado: m.rascunho ? 'EM_EDICAO' : 'PUBLICADO' };
      }));
    });
  }

  async reuniao(tx: Tx, a: AtorSecretaria, id: string) {
    const r = await this.carregarReuniao(tx, a.igreja_id, id);
    if (a.perfil === 'COMUM') await this.base.contexto(tx, a, r.contexto_id);
    if ((r.restrito && !(await this.base.concessoes(tx, a, r.contexto_id)).some(g => g.pode_consultar_restritos))) throw new NotFoundException('Reunião não encontrada.');
    return r;
  }

  async carregarReuniao(tx: Tx, igreja: string, id: string) {
    const r = await tx.reuniao.findFirst({ where: { id, igreja_id: igreja }, include: incluirReuniao });
    if (!r) throw new NotFoundException('Reunião não encontrada.');
    return comDataHora(r, await fusoDaReuniao(tx, igreja));
  }

  validarModalidadeReuniao(contexto: { tipo: string; orgao: { tipo: string } | null }, modalidade: dto.ReuniaoInput['modalidade']) {
    const assembleia = modalidade === 'AGO' || modalidade === 'AGE';
    if ((contexto.tipo === 'ASSEMBLEIA_GERAL') !== assembleia ||
        (modalidade === 'REGULAR' && !['CONSELHO', 'JUNTA'].includes(contexto.orgao?.tipo ?? ''))) {
      throw new BadRequestException('Modalidade da reunião incompatível com o contexto.');
    }
  }

  async validarReuniao(tx: Tx, a: AtorSecretaria, contexto: string, v: dto.ReuniaoInput) {
    this.validarModalidadeReuniao(await this.base.contexto(tx, a, contexto), v.modalidade);
    if (v.restrito) await this.base.competente(tx, a, contexto, 'pode_consultar_restritos');
    const ids = v.participantes.map(p => p.pessoa_id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Informe cada pessoa uma única vez, com seus vários papéis.');
    if (await tx.pessoas.count({ where: { igreja_id: a.igreja_id, id: { in: ids } } }) !== ids.length) throw new BadRequestException('Participante não pertence à igreja.');
    if (v.participantes.filter(p => p.presente).length > v.universo_informado) throw new BadRequestException('Presença maior que universo informado.');
  }

  async participantes(tx: Tx, a: Pick<AtorSecretaria,'igreja_id'>, r: { id: string; contexto_id: string }, v: dto.ReuniaoInput) {
    await tx.participante_reuniao.deleteMany({ where: { reuniao_id: r.id, igreja_id: a.igreja_id } });
    if (!v.participantes.length) return;
    const pessoas = await tx.pessoas.findMany({ where: { igreja_id: a.igreja_id, id: { in: v.participantes.map(p => p.pessoa_id) } }, select: { id: true, nome_completo: true } });
    const nomes = new Map(pessoas.map(p => [p.id, p.nome_completo]));
    if (nomes.size !== v.participantes.length) throw new BadRequestException('Participante inválido para a igreja.');
    await tx.participante_reuniao.createMany({ data: v.participantes.map(p => ({ igreja_id: a.igreja_id, contexto_id: r.contexto_id,
      reuniao_id: r.id, pessoa_id: p.pessoa_id, presente: p.presente, papeis: [...new Set(p.papeis)], retrato: { nome: nomes.get(p.pessoa_id)! } })) });
  }

  async salvarPauta(tx: Tx, r: { id: string; igreja_id: string; contexto_id: string }, pauta: string,
    itens?: { id?: string; descricao: string; proponente_id: string | null }[]) {
    const atuais = await tx.item_pauta_reuniao.findMany({ where: { reuniao_id: r.id }, orderBy: { ordem: 'asc' } });
    if (!itens) {
      if (atuais.map(i => i.descricao).join('\n') === pauta) return;
      if (atuais.length > 1 || atuais.some(i => i.proponente_id)) throw new ConflictException('Edite a pauta por itens para preservar os proponentes.');
      itens = [{ id: atuais[0]?.id, descricao: pauta, proponente_id: null }];
    }
    const ids = [...new Set(itens.flatMap(i => i.proponente_id ? [i.proponente_id] : []))];
    if (ids.length && await tx.pessoas.count({ where: { igreja_id: r.igreja_id, id: { in: ids } } }) !== ids.length)
      throw new BadRequestException('Proponente não pertence à igreja.');
    const porId = new Map(atuais.map(i => [i.id, i]));
    const mantidos = itens.flatMap(i => i.id ? [i.id] : []);
    if (new Set(mantidos).size !== mantidos.length || mantidos.some(id => !porId.has(id)))
      throw new BadRequestException('Item de pauta inválido para esta reunião.');
    // Clientes anteriores enviam a lista sem IDs. Conservar os itens reconhecíveis.
    if (!mantidos.length) {
      const disponiveis = [...atuais];
      itens = itens.map(item => {
        const i = disponiveis.findIndex(a => a.descricao === item.descricao && a.proponente_id === item.proponente_id);
        if (i < 0) return item;
        const [anterior] = disponiveis.splice(i, 1);
        mantidos.push(anterior.id);
        return { ...item, id: anterior.id };
      });
    }
    const retirados = atuais.filter(i => !mantidos.includes(i.id));
    if (retirados.length && await tx.resolucao.count({ where: { igreja_id: r.igreja_id, item_pauta_id: { in: retirados.map(i => i.id) } } }))
      throw new ConflictException('Um item retirado está vinculado a uma deliberação da ata.');
    await tx.item_pauta_reuniao.deleteMany({ where: { reuniao_id: r.id, id: { notIn: mantidos } } });
    for (const [indice, item] of itens.entries()) {
      const dados = { ordem: indice + 1, descricao: item.descricao, proponente_id: item.proponente_id };
      if (!item.id) {
        await tx.item_pauta_reuniao.create({ data: { ...dados, reuniao_id: r.id, contexto_id: r.contexto_id, igreja_id: r.igreja_id } });
        continue;
      }
      const anterior = porId.get(item.id)!;
      if (anterior.ordem !== dados.ordem || anterior.descricao !== dados.descricao || anterior.proponente_id !== dados.proponente_id)
        await tx.item_pauta_reuniao.update({ where: { id: item.id }, data: dados });
    }
  }

  private async localEfetivo(tx: Tx, igreja_id: string, id?: string | null, anterior?: string | null) {
    if (id === undefined || id === anterior) return {};
    if (!id) return { local_efetivo_id: null, local_efetivo_retrato: Prisma.DbNull };
    const local = await tx.local_reuniao.findFirst({ where: { id, igreja_id } });
    if (!local) throw new BadRequestException('Local efetivo indisponível nesta igreja.');
    return { local_efetivo_id: id, local_efetivo_retrato: retratoLocal(local) };
  }

  private async exigirAgendamento(tx: Tx, a: AtorSecretaria, contexto: string) {
    const u = await this.base.operador(tx, a);
    if (!await this.base.atuacao.podeAgendar(tx, await this.base.contexto(tx, a, contexto), u.pessoa_id))
      throw new ForbiddenException('O agendamento exige a presidência ou um cargo autorizado a emitir a convocação.');
  }

  criarReuniao(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.reuniaoSchema, dados);
    return this.base.comando(a, 'CRIAR_REUNIAO', v.contexto_id, v, tx => this.gravarReuniao(tx, a, v));
  }

  async gravarReuniao(tx: Tx, a: AtorSecretaria, v: z.infer<typeof dto.reuniaoSchema>) {
      await this.base.preparar(tx, a, v.contexto_id);
      if (v.dados.situacao === 'AGENDADA' || (!v.dados.situacao && v.dados.data >= await hojeDaIgreja(tx, a.igreja_id)))
        await this.exigirAgendamento(tx, a, v.contexto_id);
      if (v.dados.situacao === 'AGENDADA' && !v.local_id) throw new BadRequestException('Selecione um local cadastrado para agendar.');
      await this.validarReuniao(tx, a, v.contexto_id, v.dados);
      const { itens_pauta, ...dadosReuniao } = v.dados;
      const local = await this.localParaReuniao(tx, a.igreja_id, v.local_id, dadosReuniao.local);
      dadosReuniao.local = local.nome;
      const efetivo = await this.localEfetivo(tx, a.igreja_id, v.local_efetivo_id);
      const instalacaoFormal = ['AGO','AGE'].includes(dadosReuniao.modalidade) &&
        (!!dadosReuniao.situacao || dadosReuniao.data >= await hojeDaIgreja(tx, a.igreja_id));
      if (instalacaoFormal && dadosReuniao.participantes.some(p => p.papeis.some(ehPapelMesa)))
        throw new BadRequestException('Registre a eleição dos titulares na instalação da mesa.');
      const r = await tx.reuniao.create({ data: { instalacao_formal: instalacaoFormal, ...efetivo, ...local.vinculo, igreja_id: a.igreja_id, contexto_id: v.contexto_id, restrito: v.dados.restrito, modalidade: v.dados.modalidade, data: dataCivil(v.dados.data), dados: json(dadosReuniao) } });
      await this.salvarPauta(tx, r, dadosReuniao.pauta, itens_pauta);
      await this.participantes(tx, a, r, v.dados);
      return { id: r.id, revisao: 1 };
  }

  editarReuniao(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.editarReuniaoSchema, dados);
    return this.base.comando(a, 'EDITAR_REUNIAO', id, v, async tx => {
      const r = await this.reuniao(tx, a, id);
      await this.base.preparar(tx, a, r.contexto_id);
      this.base.conferirRevisao(r.revisao, v.revisao);
      if (await tx.documento_versao.count({ where: { reuniao_id: id, documento: { tipo: 'ATA' }, OR: [{ congelado_em: { not: null } }, { deliberacoes: { some: {} } }] } }) || await tx.deliberacao_ata.count({ where: { reuniao_id: id } })) throw new BadRequestException('Reunião formalizada é preservada; registre reunião/ato complementar.');
      await this.validarReuniao(tx, a, r.contexto_id, v.dados);
      const anterior = dto.validar(dto.reuniaoDadosSchema, r.dados);
      const reagendada = v.dados.situacao === 'AGENDADA' || (anterior.data !== v.dados.data && v.dados.data >= await hojeDaIgreja(tx, a.igreja_id));
      const instalacaoFormal = r.instalacao_formal || (['AGO','AGE'].includes(v.dados.modalidade) && reagendada);
      if (instalacaoFormal) {
        const mesa = (participantes: dto.ReuniaoInput['participantes']) => participantes.flatMap(p =>
          p.papeis.filter(ehPapelMesa).map(papel => [p.pessoa_id, papel, p.presente].join('/'))).sort().join('|');
        if ((r.instalacao_formal ? mesa(anterior.participantes) : '') !== mesa(v.dados.participantes))
          throw new BadRequestException('Altere os titulares pela instalação da mesa da assembleia.');
        if (mesa(anterior.participantes) && (anterior.data !== v.dados.data || !['EM_ANDAMENTO','ENCERRADA'].includes(v.dados.situacao ?? '')))
          throw new BadRequestException('Preserve a data e a realização da assembleia instalada.');
        if (v.dados.quorum_conferido)
          conferirVotacao(await mesaVigente(tx, r), v.dados.participantes, v.dados.quorum_minimo, true);
      }
      if (anterior.situacao && (!v.dados.situacao || (anterior.horario_previsto && !v.dados.horario_previsto)))
        throw new ConflictException('Atualize o formulário para preservar o agendamento.');
      if (r.restrito && !v.dados.restrito) throw new BadRequestException('Sigilo não pode ser removido por edição.');
      const { itens_pauta, ...dadosReuniao } = v.dados;
      const local = await this.localParaReuniao(tx, a.igreja_id, v.local_id, dadosReuniao.local, r);
      dadosReuniao.local = local.nome;
      const efetivo = await this.localEfetivo(tx, a.igreja_id, v.local_efetivo_id, r.local_efetivo_id);
      await tx.reuniao.update({ where: { id }, data: { instalacao_formal: instalacaoFormal, ...efetivo, ...local.vinculo, restrito: v.dados.restrito, modalidade: v.dados.modalidade, data: dataCivil(v.dados.data), dados: json(dadosReuniao), revisao: { increment: 1 } } });
      await this.salvarPauta(tx, r, dadosReuniao.pauta, itens_pauta);
      await this.participantes(tx, a, r, v.dados);
      const mudouSituacaoAgendada = v.dados.situacao && anterior.situacao !== v.dados.situacao &&
        ['ADIADA', 'CANCELADA', 'AGENDADA'].includes(v.dados.situacao);
      if ((reagendada && !r.instalacao_formal && instalacaoFormal) || mudouSituacaoAgendada || (anterior.situacao && planejamentoDaReuniao(r) !== planejamentoDaReuniao(await this.reuniao(tx, a, id))))
        await this.exigirAgendamento(tx, a, r.contexto_id);
      return { id, revisao: r.revisao + 1 };
    });
  }

  async listarReunioes(a: AtorSecretaria, contexto: string, pagina: number) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a); await this.base.contexto(tx, a, contexto);
      const restritos = (await this.base.concessoes(tx, a, contexto)).some(g => g.pode_consultar_restritos);
      const reunioes = await tx.reuniao.findMany({ where: { igreja_id: a.igreja_id, contexto_id: contexto, ...(!restritos ? { restrito: false } : {}) }, include: incluirReuniao, orderBy: [{ data: 'desc' }, { id: 'asc' }], skip: pagina * 30, take: 30 });
      const fuso = await fusoDaReuniao(tx, a.igreja_id);
      return reunioes.map(r => comDataHora(r, fuso));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
