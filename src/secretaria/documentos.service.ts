import { ReferenciasAtaService } from './referencias-ata.service';
import { contextosDasAtasRestritas, visibilidadeDocumentosSql } from './visibilidade-documentos';
import { permissoesAtasDaConta } from './sigilo-ata';
import { verificarSigiloDosAnexos } from './sigilo-anexos';
import { orgaosJuvenisRestritos } from '../orgaos/acesso-sociedades';
import { ForbiddenException } from '@nestjs/common';
import { aplicarMesa, conferirApuracoes, conferirVotacao, mesaVigente } from './mesa-assembleia';
import { cancelarNumeroAta, identificacaoDocumento, numerarAta } from './numeracao-ata-livro';
import { isDeepStrictEqual } from 'node:util';
import { permissoesModelo } from './atuacao-modelo.service';
import { ehCampoNumeracao } from './numeracao-campos';

import { exigirEditorPagina } from './liberacao-editor';
import { copiarOrigem, resolverOrigem, versoesElegiveis } from './encadeamento';
import { assinaturaFontes, prepararCampos } from './campos-documento';
import { dadosConsolidadosAta, pendenciasConteudo, pendenciasMesa, pendenciasAssinaturasReuniao, type PendenciaTramitacao } from './pendencias-tramitacao';
import { z } from 'zod';
import { buscaNumero, selecionarDocumentos, tabelasDocumentais } from './selecao-documental';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type documento, type documento_versao } from '@prisma/client';
import { SecretariaBaseService, AtorSecretaria, Tx, dataCivil, json } from './secretaria-base.service';
import { planejamentoDaReuniao, SecretariaCadastrosService } from './secretaria-cadastros.service';
import { transacaoComRetentativa } from '../orgaos/idempotencia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import * as dto from './secretaria.dto';
import { LivrosService, exigirLivros, livrosDisponiveis } from './livros.service';
import { RascunhosService, igrejaSelect, type SignatarioRenderizacao } from './rascunhos.service';
import { arquivoSemVinculoDeExpedicao, PrivateStorageService } from '../private-storage/private-storage.service';
import { assinaturasDisponiveis, cancelarExpedicao, exigirAssinaturas } from './expedicao-estado';
import { conferirCargaDeImagem } from './imagens-documentais';
import { entradaResolucoes, salvarResolucoes, validarResolucoes } from './resolucoes';
import { resolucoesSchema } from './resolucoes.dto';

type LinhaDocumento = Pick<documento,
  'id' | 'estado' | 'revisao' | 'versao_atual' | 'tipo' | 'numero' | 'identificacao_livro' | 'ano' | 'sigla' | 'restrito' | 'encaminhado_em'
> & { modelo_nome: string | null } & (
  | ({ versao_id: string } & Pick<documento_versao, 'numero_original' | 'assunto' | 'data_documento'>)
  | { versao_id: null; numero_original: null; assunto: null; data_documento: null }
);

@Injectable()
export class DocumentosService {
  constructor(private readonly referencias: ReferenciasAtaService, readonly base: SecretariaBaseService, readonly cadastros: SecretariaCadastrosService, private readonly artefatos: RascunhosService, private readonly storage: PrivateStorageService, private readonly livros: LivrosService) {}

  async validarVersao(tx: Tx, a: AtorSecretaria, contexto: string, documento: string, v: dto.VersaoInput, anterior?: Pick<documento_versao, 'id' | 'conteudo' | 'modelo_versao_id' | 'reuniao_id'>, restrito = false, numero: number | null = null, novoDocumento = false, opcoes: { sugerirSignatarios?: boolean; preparar?: boolean; convocante?: string | null; previa?: boolean } = {}) {
    const atualId = anterior?.id;
    const m = await tx.modelo_documento_versao.findFirst({
      where: { id: v.modelo_versao_id, igreja_id: a.igreja_id, contexto_id: contexto },
      include: { modelo: { select: { rascunho: { select: { modelo_id: true } }, versoes: { select: { id: true }, orderBy: { numero: 'desc' }, take: 1 } } }, imagens: { select: { arquivo_id: true } } },
    });
    if (!m) throw new BadRequestException('Versão do modelo não pertence ao contexto.');
    if (m.modelo.rascunho && (novoDocumento || anterior?.modelo_versao_id !== m.id)) {
      throw new ConflictException('O modelo está em edição. Publique-o antes de criar um documento.');
    }
    if ((novoDocumento || anterior?.modelo_versao_id !== m.id) && m.modelo.versoes[0]?.id !== m.id)
      throw new ConflictException('Selecione a versão vigente do modelo.');
    if (novoDocumento && restrito) {
      if (m.tipo === 'ATA') await this.exigirClassificacaoAta(tx, a, contexto);
      else await this.base.competente(tx, a, contexto, 'pode_consultar_restritos');
    }
    const config = dto.validar(dto.configuracaoSchema, m.configuracao);
    const vinculo = await this.livros.validarVinculo(tx, a, contexto, restrito, m, config, v, atualId);
    dto.validarCampos(config, v.conteudo.campos);
    await this.cadastros.configurar(tx, a, contexto, config);
    const c = await this.base.contexto(tx, a, contexto);
    if (m.tipo === 'ATA' && !v.reuniao_id) throw new BadRequestException('Ata exige reunião.');
    const edital = m.finalidade === 'CONVOCACAO' && m.tipo === 'OUTRO';
    const politica = config.vinculo_reuniao ?? (edital ? 'OPCIONAL' : 'NAO_PERMITE');
    if (m.tipo !== 'ATA' && (politica === 'OBRIGATORIO' && !v.reuniao_id || politica === 'NAO_PERMITE' && v.reuniao_id))
      throw new BadRequestException('Confira o vínculo com reunião exigido pelo modelo.');
    if (edital && anterior?.reuniao_id && v.reuniao_id !== anterior.reuniao_id)
      throw new ConflictException('A convocação já está vinculada a uma reunião.');
    const redatorAnterior = (anterior?.conteudo as dto.VersaoInput['conteudo'] | undefined)?.redator_ata;
    const redator = v.conteudo.redator_ata === undefined ? redatorAnterior : v.conteudo.redator_ata;
    if (redator) {
      if (m.tipo !== 'ATA') throw new BadRequestException('Redator da ata exige um modelo de ata.');
      if (redator.pessoa_id === redatorAnterior?.pessoa_id && redatorAnterior.nome) {
        v.conteudo.redator_ata = redatorAnterior;
      } else {
        const pessoa = await tx.pessoas.findFirst({ where: { id: redator.pessoa_id, igreja_id: a.igreja_id }, select: { id: true, nome_completo: true } });
        if (!pessoa) throw new BadRequestException('Selecione uma pessoa da igreja como redator da ata.');
        v.conteudo.redator_ata = { pessoa_id: pessoa.id, nome: pessoa.nome_completo };
      }
    }
    let dadosReuniao: dto.ReuniaoInput | undefined;
    const reuniao = v.reuniao_id ? await this.cadastros.reuniao(tx, a, v.reuniao_id) : undefined;
    if (a.perfil === 'COMUM' && c.orgao.tipo === 'ASSEMBLEIA_GERAL' && m.tipo !== 'ATA')
      throw new ForbiddenException('Nesse contexto a conta pode preparar a minuta da ata.');
    if (a.perfil === 'COMUM' && m.tipo === 'ATA' && anterior?.reuniao_id && anterior.reuniao_id !== v.reuniao_id) {
      const origem = await this.cadastros.reuniao(tx, a, anterior.reuniao_id);
      if (await mesaVigente(tx, origem)) throw new ForbiddenException('A mesa assume a redação da sessão instalada.');
    }
    if (reuniao) {
      if (reuniao.contexto_id !== contexto || (m.tipo === 'ATA' && reuniao.data > dataCivil(v.data_documento)) || (reuniao.restrito && !restrito && (m.tipo !== 'ATA' || anterior?.reuniao_id !== reuniao.id)))
        throw new BadRequestException('Reunião/contexto, data ou sigilo incompatíveis.');
      dadosReuniao = dto.validar(dto.reuniaoDadosSchema, reuniao.dados);
      if (edital && anterior?.reuniao_id !== reuniao.id && dadosReuniao.situacao && dadosReuniao.situacao !== 'AGENDADA')
        throw new BadRequestException('Selecione uma reunião agendada para a convocação.');
    }
    if (m.tipo === 'ATA' && reuniao?.instalacao_formal) {
      const mesa = await mesaVigente(tx, reuniao);
      if (mesa && a.perfil === 'COMUM') throw new ForbiddenException('A redação desta sessão está sob a mesa. Use o acesso temporário.');
      if (mesa) {
        aplicarMesa(v.conteudo, mesa, config);
        conferirApuracoes(mesa, reuniao.participantes, v.resolucoes);
      }
      else v.conteudo.redator_ata = null;
    }
    validarResolucoes(v, config, dadosReuniao, reuniao?.itens_pauta);
    if (config.motivador === 'NAO_PERMITE' && v.motivador_id) throw new BadRequestException('Modelo não permite motivador.');
    await this.base.conferirMotivador(tx, a, v.motivador_id, documento, atualId);
    // Referência a acervo restrito não pode ser publicada em documento aberto.
    if (v.motivador_id) {
      const motivador = await tx.documento_versao.findUniqueOrThrow({ where: { id: v.motivador_id }, include: { documento: true } });
      if (motivador.documento.restrito && (!restrito ||
        (motivador.documento.tipo === 'ATA' && (m.tipo !== 'ATA' || motivador.contexto_id !== contexto)))) throw new BadRequestException('Documento motivado deve preservar o sigilo da fonte.');
    }
    const preparador = !anterior ? (await this.base.operador(tx, a)).pessoa_id : (anterior.conteudo as dto.VersaoInput['conteudo']).autores_origem?.preparador;
    const abertura = vinculo?.natureza === 'ABERTURA' ? await this.livros.responsaveisAbertura(tx, c, vinculo.livro, v.data_documento, config, preparador) : null;
    const indicados = v.conteudo.arrolados.filter(p => p.assina && p.obrigatorio && p.papeis.includes('SECRETARIO'));
    const secretarioLivro = abertura?.titulares.find(p => indicados.length === 1 && indicados[0].pessoa_id === p.pessoa_id) ?? abertura?.secretario;
    if (abertura) {
      v.conteudo.campos.NOME_SECRETARIO_LIVRO = secretarioLivro?.nome ?? '';
      v.conteudo.campos.NOME_PREPARADOR = abertura.preparador?.nome ?? '';
      if (opcoes.sugerirSignatarios) {
        for (const [papel, titular] of [['SECRETARIO', abertura.secretario], ['PRESIDENTE', abertura.presidente]] as const) {
          if (!titular) continue;
          const existente = v.conteudo.arrolados.find(p => p.pessoa_id === titular.pessoa_id);
          if (existente) existente.papeis.push(papel);
          else v.conteudo.arrolados.push({ pessoa_id: titular.pessoa_id, papeis: [papel], assina: true, obrigatorio: true,
            responsavel: papel === 'SECRETARIO', fundamento: 'Titular em exercício na data do termo', cargo_id: null, cargos_ids: [] });
        }
      }
    }
    const ids = v.conteudo.arrolados.map(p => p.pessoa_id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Uma pessoa deve ser arrolada uma única vez com todos os papéis.');
    if (await tx.pessoas.count({ where: { id: { in: ids }, igreja_id: a.igreja_id } }) !== ids.length) throw new BadRequestException('Arrolado de outra igreja.');
    for (const p of v.conteudo.arrolados) {
      const cargos = dto.cargosDoArrolado(p);
      if (cargos.length && (!c.orgao_id || await tx.cargo_orgao.count({ where: { id: { in: cargos }, igreja_id: a.igreja_id, orgao_id: c.orgao_id, ativo: true } }) !== cargos.length)) throw new BadRequestException('Cargo não existe neste contexto.');
    }
    const imagensModelo = new Set(m.imagens.map(imagem => imagem.arquivo_id));
    if (!documento) {
      if (!v.conteudo.composicao && !v.conteudo.estrutura && !v.conteudo.teor && config.composicao_padrao) {
        v.conteudo.composicao = config.composicao_padrao;
      }
      if (!v.conteudo.composicao) v.conteudo.estrutura ??= config.estrutura_padrao;
    }
    const imagens = dto.imagensDaEstrutura(v.conteudo.estrutura, v.conteudo.composicao);
    for (const imagem of imagens) {
      // A ocorrência carrega a referência. O vínculo físico só é criado após a validação de acesso abaixo.
      if (('ocorrencia_id' in imagem || !documento && imagensModelo.has(imagem.arquivo_id)) &&
          !v.conteudo.anexos.some(a => a.arquivo_id === imagem.arquivo_id)) {
        v.conteudo.anexos.push({ arquivo_id: imagem.arquivo_id, nome: imagem.descricao.trim() || 'Imagem do documento' });
      }
    }
    const copiados = opcoes.sugerirSignatarios && !v.motivador_id ? {} : await resolverOrigem(tx, this.base, a, contexto, restrito, config, v, atualId, m.tipo === 'ATA' ? v.reuniao_id ?? undefined : undefined, novoDocumento);

    await prepararCampos(tx, a.igreja_id, config, v, {
      contexto: c, reuniao, livro: vinculo?.livro, previsto: edital,
      planejamento: edital && reuniao ? planejamentoDaReuniao(reuniao) : undefined,
      secretarioLivro: secretarioLivro?.pessoa_id, preparador, convocante: edital ? opcoes.convocante ?? (!anterior && !opcoes.preparar ? preparador : null) : null,
      atualizar: !!v.atualizar_fontes || opcoes.previa,
    }, copiados, numero, anterior);
    const arquivos = v.conteudo.anexos.map(p => p.arquivo_id);
    if (arquivos.length > 50) throw new BadRequestException('Até 50 anexos por versão.');
    if (new Set(arquivos).size !== arquivos.length) throw new BadRequestException('Anexo duplicado.');
    if (imagens.some(b => !arquivos.includes(b.arquivo_id))) throw new BadRequestException('Imagem deve ser um anexo privado da versão.');
    const carga = {bytes:0, pixels:0};
    for (const id of arquivos) {
      // Novos anexos só podem usar upload próprio. Um anexo já vinculado pode ser mantido nas versões seguintes.
      const f = await tx.arquivo_privado.findFirst({ where: { id, igreja_id: a.igreja_id,
        ...(!imagensModelo.has(id) && { anexos_documento: { none: { versao: { documento: { tipo: 'ATA', restrito: true,
          ...(documento && { id: { not: documento } }),
          ...(m.tipo === 'ATA' && restrito && { contexto_id: { not: contexto } }),
        } } } } }),
        artefatos_documento: { none: {} }, livros_historicos: { none: {} }, registros_livro: { none: {} }, ...arquivoSemVinculoDeExpedicao } });
      if (!f || (f.usuario_id !== a.sub && !imagensModelo.has(id) && !(documento && await tx.anexo_documento.findFirst({ where: { arquivo_id: id, igreja_id: a.igreja_id, versao: { documento_id: documento } } })))) throw new BadRequestException('Anexo privado indisponível para vinculação.');
      const usos = imagens.filter(b => b.arquivo_id === id).length;
      if (!usos) continue;
      await conferirCargaDeImagem(carga, f.tamanho, usos, () => this.storage.readVerified(f));
    }
    const conferencia = abertura && vinculo ? createHash('sha256').update(JSON.stringify([
      vinculo.livro.id, vinculo.livro.revisao, m.id, v.data_documento, abertura,
    ])).digest('hex') : null;
    return { m, config, c, vinculo, abertura, conferencia };
  }

  private async retratoArrolado(tx: Tx, a: AtorSecretaria, orgao: string | null, p: dto.VersaoInput['conteudo']['arrolados'][number]) {
    const pessoa = await tx.pessoas.findFirstOrThrow({ where: { id: p.pessoa_id, igreja_id: a.igreja_id }, select: { nome_completo: true, email: true } });
    const ids = dto.cargosDoArrolado(p);
    const cargos = ids.length ? await tx.cargo_orgao.findMany({ where: { id: { in: ids }, igreja_id: a.igreja_id, orgao_id: orgao! }, select: { id: true, nome: true, codigo: true } }) : [];
    cargos.sort((a, b) => a.id.localeCompare(b.id));
    return { nome: pessoa.nome_completo, email: pessoa.email, cargo: cargos[0] ?? null, cargos, fundamento: p.fundamento };
  }

  async salvarArroladosAnexos(tx: Tx, a: AtorSecretaria, versaoId: string, contexto: string, conteudo: dto.VersaoInput['conteudo']) {
    const c = await this.base.contexto(tx, a, contexto);
    await tx.cargo_arrolado_documento.deleteMany({ where: { versao_id: versaoId } });
    await tx.arrolado_documento.deleteMany({ where: { versao_id: versaoId } });
    await tx.anexo_documento.deleteMany({ where: { versao_id: versaoId } });
    for (const p of conteudo.arrolados) {
      const retrato = await this.retratoArrolado(tx, a, c.orgao_id, p);
      const arrolado = await tx.arrolado_documento.create({ data: { igreja_id: a.igreja_id, contexto_id: contexto, versao_id: versaoId, pessoa_id: p.pessoa_id, cargo_id: p.cargo_id, orgao_id: p.cargo_id ? c.orgao_id : null, papeis: [...new Set(p.papeis)], assina: p.assina, obrigatorio: p.obrigatorio, responsavel: p.responsavel, retrato: json(retrato) } });
      for (const cargo of retrato.cargos) await tx.cargo_arrolado_documento.create({ data: { igreja_id: a.igreja_id, contexto_id: contexto, versao_id: versaoId, arrolado_id: arrolado.id, cargo_id: cargo.id, orgao_id: c.orgao_id! } });
    }
    for (const p of conteudo.anexos) await tx.anexo_documento.create({ data: { igreja_id: a.igreja_id, contexto_id: contexto, versao_id: versaoId, arquivo_id: p.arquivo_id, nome: p.nome } });
  }

  async novaVersao(tx: Tx, a: AtorSecretaria, documento: string, contexto: string, numero: number, v: dto.VersaoInput, retifica?: string) {
    const r = await tx.documento_versao.create({ data: { igreja_id: a.igreja_id, contexto_id: contexto, documento_id: documento, numero, modelo_versao_id: v.modelo_versao_id, livro_id: v.livro_id, reuniao_id: v.reuniao_id, motivador_id: v.motivador_id, assunto: v.assunto, data_documento: dataCivil(v.data_documento), conteudo: json(v.conteudo), retifica_versao_id: retifica } });
    await this.salvarArroladosAnexos(tx, a, r.id, contexto, v.conteudo);
    await salvarResolucoes(tx, { igreja_id: a.igreja_id, contexto_id: contexto, versao_id: r.id }, v.resolucoes);
    return r;
  }

  async previaTermo(a: AtorSecretaria, livroId: string, dados: unknown, finalidade: 'TERMO_ABERTURA' | 'TERMO_ENCERRAMENTO') {
    exigirLivros();
    const pedido = dto.validar(z.strictObject({ modelo_versao_id: z.uuid(), data: dto.dia.optional(), acao: z.enum(['criar', 'preparar']).default('criar') }), dados);
    return this.base.prisma.$transaction(async tx => {
      const livro = await this.livros.autorizado(tx, a, livroId);
      const modelo = await tx.modelo_documento_versao.findFirst({ where: { id: pedido.modelo_versao_id, igreja_id: a.igreja_id,
        contexto_id: livro.contexto_id, tipo: 'OUTRO', finalidade } });
      if (a.perfil === 'COMUM' && modelo && !await tx.modelo_documento.findFirst({ where: { id: modelo.modelo_id, rascunho: null,
        versoes: { none: { numero: { gt: modelo.numero } } } }, select: { id: true } })) throw new ConflictException('Selecione a versão vigente do modelo publicado.');
      if (!modelo) throw new BadRequestException('Selecione um modelo da finalidade solicitada neste contexto.');
      await this.base.autorizarModelo(tx, a, livro.contexto_id, modelo.configuracao, pedido.acao);
      const versao = dto.versaoSchema.parse({ modelo_versao_id: modelo.id, livro_id: livroId, assunto: finalidade === 'TERMO_ABERTURA' ? 'Abertura do livro de atas' : 'Encerramento do livro de atas',
        data_documento: pedido.data ?? await hojeDaIgreja(tx, a.igreja_id), conteudo: { teor: '', campos: {}, anexos: [], arrolados: [] } });
      const { abertura, conferencia } = await this.validarVersao(tx, a, livro.contexto_id, '', versao, undefined, livro.restrito, null, true, { sugerirSignatarios: true });
      if (versao.conteudo.composicao) exigirEditorPagina(livro.contexto_id);
      if (finalidade === 'TERMO_ENCERRAMENTO') return { versao };
      if (!abertura || !conferencia) throw new ConflictException('Este modelo não está disponível para abrir o livro.');
      return { versao, conferencia, preparador: abertura.preparador, secretario: abertura.secretario,
        presidente: abertura.presidente, pendencias: abertura.pendencias };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async exigirClassificacaoAta(tx: Tx, a: AtorSecretaria, contexto: string) {
    if (!(await permissoesAtasDaConta(tx, a.igreja_id, a.sub)).get(contexto)?.classificar)
      throw new ForbiddenException('A classificação da ata exige cargo ou mandato vigente neste contexto.');
  }

  alterarSigiloAta(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(z.strictObject({ ...dto.chave, ...dto.revisao, restrito: z.boolean() }), dados);
    return this.base.comando(a, 'SIGILO_ATA', id, v, async tx => {
      const ata = await tx.documento.findFirstOrThrow({ where: { id, igreja_id: a.igreja_id, tipo: 'ATA' }, select: { revisao: true, restrito: true } });
      this.base.conferirRevisao(ata.revisao, v.revisao);
      if (ata.restrito === v.restrito) return { id, revisao: ata.revisao };
      return tx.documento.update({ where: { id, igreja_id: a.igreja_id, revisao: v.revisao },
        data: { restrito: v.restrito, revisao: { increment: 1 } }, select: { id: true, revisao: true } });
    }, async tx => {
      const ata = await tx.documento.findFirst({ where: { id, igreja_id: a.igreja_id, tipo: 'ATA' }, select: { contexto_id: true } });
      if (!ata) throw new NotFoundException('Ata não encontrada nesta igreja.');
      await this.exigirClassificacaoAta(tx, a, ata.contexto_id);
    });
  }

  async conferirAcessoAnexo(a: AtorSecretaria, arquivo: string) {
    await this.base.prisma.$transaction(tx => verificarSigiloDosAnexos(tx, a.igreja_id, a.sub, [arquivo]));
  }

  criar(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.documentoSchema, dados);
    return this.base.comando(a, 'CRIAR_DOCUMENTO', v.contexto_id, v, async tx => {
      await this.base.preparar(tx, a, v.contexto_id);
      const entrada = structuredClone(v.versao);
      if (v.agendamento) {
        if (a.perfil === 'COMUM') throw new ForbiddenException('Agendamento exige autorização própria.');
        if (entrada.reuniao_id || v.agendamento.dados.situacao !== 'AGENDADA') throw new BadRequestException('Informe apenas um novo agendamento.');
        const r = await this.cadastros.gravarReuniao(tx, a, { ...v.agendamento, contexto_id: v.contexto_id, idempotencia: v.idempotencia });
        entrada.reuniao_id = r.id;
      }
      const { m, config, vinculo, conferencia, c } = await this.validarVersao(tx, a, v.contexto_id, '', entrada, undefined, v.restrito, null, true, { preparar: v.acao === 'preparar' });
      if (v.conferencia_abertura && conferencia !== v.conferencia_abertura) throw new ConflictException('Os dados do livro ou dos responsáveis mudaram. Reabra a preparação para conferi-los.');
      if (v.agendamento && m.finalidade !== 'CONVOCACAO') throw new BadRequestException('O agendamento conjunto exige um modelo de convocação.');
      if (entrada.conteudo.composicao || config.composicao_padrao) exigirEditorPagina(v.contexto_id);
      await this.base.autorizarModelo(tx, a, v.contexto_id, m.configuracao, v.acao ?? 'criar');
      if (m.finalidade === 'CONVOCACAO' && entrada.reuniao_id) {
        const aberto = await this.cadastros.convocacaoEmCurso(tx, a, v.contexto_id, entrada.reuniao_id);
        if (aberto) {
          if (!v.retomar_convocacao || aberto.modelo_versao_id !== m.id || aberto.documento.restrito !== v.restrito || aberto.documento.estado !== 'EM_EDICAO')
            throw new ConflictException('Já existe uma convocação em andamento para esta reunião. Consulte a ficha da reunião.');
          await this.base.documento(tx, a, aberto.documento.id);
          return { id: aberto.documento.id, revisao: aberto.documento.revisao };
        }
      }
      await this.livros.fixarTermo(tx, vinculo);
      const d = await tx.documento.create({ data: { igreja_id: a.igreja_id, contexto_id: v.contexto_id, restrito: v.restrito, tipo: m.tipo, perfil: m.tipo === 'ATA' ? config.perfil : 'CORRESPONDENCIA' } });
      await numerarAta(tx, d, entrada, vinculo?.livro, c.orgao?.nome ?? c.nome);
      await this.novaVersao(tx, a, d.id, v.contexto_id, 1, entrada);
      return { id: d.id, revisao: 1 };
    });
  }

  async previaFontes(a: AtorSecretaria, id: string, dados: unknown) {
    const { versao, revisao } = dto.validar(z.strictObject({ versao: dto.versaoSchema, ...dto.revisao }), dados);
    return this.base.prisma.$transaction(async tx => {
      const d = await this.base.documento(tx, a, id);
      this.base.conferirRevisao(d.revisao, revisao);
      const atual = d.versoes.find(v => v.numero === d.versao_atual)!;
      if (!atual.modelo || atual.modelo.id !== versao.modelo_versao_id || d.estado !== 'EM_EDICAO') throw new ConflictException('Atualização disponível na edição da minuta.');
      await this.base.autorizarModelo(tx, a, d.contexto_id, atual.modelo.configuracao, 'editar', true);
      versao.resolucoes ??= entradaResolucoes(atual.resolucoes);
      delete versao.atualizar_fontes;
      await this.validarVersao(tx, a, d.contexto_id, id, versao, atual, d.restrito, d.numero, false, { previa: true });
      return { assinatura: assinaturaFontes(versao), valores: versao.conteudo.valores ?? {}, planejamento_origem: versao.conteudo.planejamento_origem };
    }, { isolationLevel: 'RepeatableRead' });
  }

  editar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.editarDocumentoSchema, dados);
    return this.base.comando(a, 'EDITAR_DOCUMENTO', id, v, async tx => {
      const d = await this.base.documento(tx, a, id);
      await this.base.preparar(tx, a, d.contexto_id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      if (d.estado !== 'EM_EDICAO') throw new BadRequestException('Conteúdo formalizado exige retificação/versionamento.');
      const atual = d.versoes.find(r => r.numero === d.versao_atual)!;
      if (atual.modelo) await this.base.autorizarModelo(tx, a, d.contexto_id, atual.modelo.configuracao, 'editar', true);
      const composicaoAnterior = (atual.conteudo as dto.VersaoInput['conteudo']).composicao;
      if (!composicaoAnterior && v.versao.conteudo.composicao) exigirEditorPagina(d.contexto_id);
      if (composicaoAnterior && !v.versao.conteudo.composicao) {
        throw new BadRequestException('Reabra esta versão no editor de página.');
      }
      if (atual.livro_id) exigirLivros();
      const versao = { ...v.versao, conteudo: structuredClone(v.versao.conteudo), resolucoes: v.versao.resolucoes ?? entradaResolucoes(atual.resolucoes) };
      const { m, config, vinculo, c } = await this.validarVersao(tx, a, d.contexto_id, id, versao, atual, d.restrito, d.numero);
      if (m.finalidade === 'CONVOCACAO' && versao.reuniao_id && (m.id !== atual.modelo_versao_id || atual.reuniao_id !== versao.reuniao_id)) {
        const aberto = await this.cadastros.convocacaoEmCurso(tx, a, d.contexto_id, versao.reuniao_id);
        if (aberto && aberto.documento.id !== id) throw new ConflictException('Já existe uma convocação em andamento para esta reunião.');
      }
      if (m.id !== atual.modelo_versao_id) await this.base.autorizarModelo(tx, a, d.contexto_id, m.configuracao, 'criar');
      if ((dto.finalidadeTermo(atual.modelo?.finalidade) || dto.finalidadeTermo(m.finalidade)) &&
          (atual.modelo?.finalidade !== m.finalidade || atual.livro_id !== v.versao.livro_id)) {
        throw new BadRequestException('A finalidade e o livro de um termo são definidos na criação.');
      }
      await this.livros.fixarTermo(tx, vinculo);
      if (m.tipo !== d.tipo || (m.tipo === 'ATA' && config.perfil !== d.perfil) || (d.ano && d.ano !== Number(v.versao.data_documento.slice(0, 4)))) throw new BadRequestException('Tipo, série e ano reservado não podem mudar.');
      await numerarAta(tx, d, versao, vinculo?.livro, c.orgao?.nome ?? c.nome, atual.livro_id);
      if (atual.congelado_em) throw new BadRequestException('Versão congelada.');
      await tx.documento_versao.update({ where: { id: atual.id }, data: { modelo_versao_id: v.versao.modelo_versao_id, livro_id: v.versao.livro_id ?? null, reuniao_id: v.versao.reuniao_id, motivador_id: v.versao.motivador_id, assunto: v.versao.assunto, data_documento: dataCivil(v.versao.data_documento), conteudo: json(versao.conteudo), revisao_conteudo: { increment: 1 } } });
      const escopo = { versao_id: atual.id, igreja_id: a.igreja_id, contexto_id: d.contexto_id };
      await tx.resolucao.deleteMany({ where: escopo });
      await this.salvarArroladosAnexos(tx, a, atual.id, d.contexto_id, versao.conteudo);
      await salvarResolucoes(tx, escopo, versao.resolucoes);
      await tx.documento.update({ where: { id }, data: { encaminhado_em: null, revisao: { increment: 1 } } });
      return { id, revisao: d.revisao + 1 };
    });
  }

  async conferirAprovacao(tx: Tx, a: AtorSecretaria, d: Awaited<ReturnType<SecretariaBaseService['documento']>>, encaminhando = false) {
    const atual = d.versoes.find(v => v.numero === d.versao_atual)!;
    if (!atual.modelo_versao_id) throw new BadRequestException('Ata legada já conferida no acervo.');
    const entrada = { modelo_versao_id: atual.modelo_versao_id, livro_id: atual.livro_id, reuniao_id: atual.reuniao_id, motivador_id: atual.motivador_id, assunto: atual.assunto, data_documento: atual.data_documento.toISOString().slice(0, 10), conteudo: dto.validar(dto.conteudoSchema, atual.conteudo), resolucoes: dto.validar(resolucoesSchema, entradaResolucoes(atual.resolucoes)) };
    const { config, c, vinculo, abertura } = await this.validarVersao(tx, a, d.contexto_id, d.id, entrada, atual, d.restrito, d.numero, false, { convocante: encaminhando ? (await this.base.operador(tx, a)).pessoa_id : null });
    if (atual.modelo?.finalidade === 'CONVOCACAO' && atual.reuniao_id && entrada.conteudo.planejamento_origem) {
      const reuniao = await this.cadastros.reuniao(tx, a, atual.reuniao_id);
      if (planejamentoDaReuniao(reuniao) !== entrada.conteudo.planejamento_origem)
        throw new ConflictException('O agendamento mudou. Confira os dados de origem e atualize a minuta antes de encaminhar ou aprovar.');
    }
    if (abertura && config.papeis_obrigatorios.includes('SECRETARIO')) {
      this.livros.conferirSecretarioAbertura(abertura, entrada.conteudo.arrolados);
    }
    const pendencias = pendenciasConteudo(config, entrada.conteudo, atual.motivador_id, entrada.resolucoes.length);
    if (pendencias.length) throw new BadRequestException(pendencias[0].mensagem);
    await this.base.atuacao.conferirCargosArrolados(tx, c, entrada);
    await this.base.atuacao.conferirAssinaturas(tx, c, config.atuacao, entrada);
    const competenciaTermo = vinculo && await this.livros.conferirResponsabilidade(tx, vinculo, entrada);
    if (d.tipo === 'ATA') {
      const r = await this.cadastros.reuniao(tx, a, atual.reuniao_id!);
      const dados = dto.validar(dto.reuniaoDadosSchema, r.dados);
      if (r.data > dataCivil(entrada.data_documento) || r.data > dataCivil(await hojeDaIgreja(tx, a.igreja_id))) throw new BadRequestException('Confira a data do ato e aguarde a realização da reunião para formalizar a ata.');
      const consolidados = dadosConsolidadosAta(dados, entrada.conteudo);
      if (Date.parse(consolidados.fim!) > Date.now()) throw new BadRequestException('Confira o encerramento efetivo da ata.');
      await this.cadastros.conferirConvocacao(tx,a,r.contexto_id,consolidados,r.id,dados);
      const pendencias = pendenciasMesa(consolidados, r.participantes, d.identificacao_livro || dados.situacao ? entrada.conteudo : undefined);
      pendencias.push(...pendenciasAssinaturasReuniao(config.assinaturas_reuniao, r.participantes, entrada.conteudo));
      if (pendencias.length) throw new BadRequestException(pendencias[0].mensagem);
    }
    return { atual, entrada, config, c, vinculo, competenciaTermo };
  }

  private conferirProntidao(d: Awaited<ReturnType<SecretariaBaseService['documento']>>, atual: typeof d.versoes[number]) {
    if (!d.encaminhado_em || !d.numero) throw new BadRequestException('Encaminhe a versão antes de aprovar.');
    if (d.tipo === 'ATA' && (atual.deliberacoes.at(-1)?.resultado !== 'APROVADA' || atual.deliberacoes.at(-1)?.revisao_conteudo !== atual.revisao_conteudo)) {
      throw new BadRequestException('Registre a aprovação deliberativa desta versão da ata.');
    }
  }

  medir(a: AtorSecretaria, id: string, dados: unknown) {
    exigirLivros();
    const v = dto.validar(dto.medicaoLivroSchema, dados);
    return transacaoComRetentativa(this.base.prisma, async tx => {
      const d = await this.base.documento(tx, a, id);
      await this.base.preparar(tx, a, d.contexto_id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      if (d.estado !== 'EM_EDICAO') throw new BadRequestException('A medição exige documento em edição.');
      const { atual, entrada, c, vinculo } = await this.conferirAprovacao(tx, a, d);
      this.conferirProntidao(d, atual);
      if (!vinculo) throw new BadRequestException('A versão não está vinculada a um livro.');
      const igreja = await tx.igreja.findUniqueOrThrow({ where: { id: a.igreja_id }, select: igrejaSelect });
      const signatarios: SignatarioRenderizacao[] = [];
      for (const p of entrada.conteudo.arrolados) {
        signatarios.push({ pessoa_id: p.pessoa_id, assina: p.assina, retrato: await this.retratoArrolado(tx, a, c.orgao_id, p) });
      }
      const fonte = await this.artefatos.fonteMatriz(tx, d, { ...atual, conteudo: entrada.conteudo }, igreja, signatarios, identificacaoDocumento(d), c.orgao?.nome ?? c.nome, vinculo);
      return this.artefatos.enfileirarMedicao(tx, a, d, atual, fonte);
    }, Prisma.TransactionIsolationLevel.Serializable, erro => erro instanceof Prisma.PrismaClientKnownRequestError &&
      erro.code === 'P2002' && Array.isArray(erro.meta?.target) && erro.meta.target.includes('versao_id'));
  }

  executar(a: AtorSecretaria, id: string, operacao: 'encaminhar' | 'aprovar' | 'cancelar' | 'anular', dados: unknown) {
    const aprovacao = operacao === 'aprovar' ? dto.validar(dto.aprovacaoSchema, dados) : null;
    const v = aprovacao ?? dto.validar(dto.comandoSchema, dados);
    const modalidade = aprovacao?.modalidade;
    if (operacao === 'aprovar' && modalidade) exigirAssinaturas();
    if (operacao === 'aprovar' && assinaturasDisponiveis() && !modalidade) throw new BadRequestException('Selecione a modalidade de assinatura.');
    return this.base.comando(a, operacao.toUpperCase(), id, v, async tx => {
      const d = await this.base.documento(tx, a, id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      if (operacao === 'encaminhar') await this.base.preparar(tx, a, d.contexto_id);
      else await this.base.competente(tx, a, d.contexto_id, 'pode_aprovar');
      const versaoAtual = d.versoes.find(r => r.numero === d.versao_atual)!;
      if (operacao === 'encaminhar' && versaoAtual.modelo) await this.base.autorizarModelo(tx, a, d.contexto_id, versaoAtual.modelo.configuracao, a.perfil === 'COMUM' ? 'editar' : 'criar', true);
      if (versaoAtual.livro_id) exigirLivros();
      if (operacao === 'cancelar' || operacao === 'anular') {
        if (operacao === 'anular' ? d.estado !== 'EXPEDIDO' : !['EM_EDICAO', 'APROVADO'].includes(d.estado)) throw new BadRequestException('Transição de estado inválida.');
        if (operacao === 'cancelar') await cancelarExpedicao(tx, versaoAtual.id);
        if (operacao === 'cancelar' && versaoAtual.livro_id) {
          await cancelarNumeroAta(tx, id, 'CANCELAMENTO');
          await this.livros.cancelarReserva(tx, versaoAtual.id);
          if (dto.finalidadeTermo(versaoAtual.modelo?.finalidade)) {
            await tx.livro_atas.update({ where: { id: versaoAtual.livro_id }, data: { revisao: { increment: 1 } } });
          }
        }
        if (operacao === 'anular' && versaoAtual.livro_id && dto.finalidadeTermo(versaoAtual.modelo?.finalidade)) {
          throw new BadRequestException('Termo efetivado integra o acervo e exige ato complementar.');
        }
        await tx.documento.update({ where: { id }, data: { estado: operacao === 'anular' ? 'ANULADO' : 'CANCELADO', revisao: { increment: 1 } } });
        return { id, revisao: d.revisao + 1 };
      }
      if (d.estado !== 'EM_EDICAO') throw new BadRequestException('Documento deve estar em edição.');
      // A reserva e as conferências estão na mesma transação. Uma pendência desfaz a reserva.
      if (operacao === 'encaminhar' && d.numero === null && d.tipo === 'ATA' && versaoAtual.livro_id) {
        const contexto = await this.base.contexto(tx, a, d.contexto_id);
        const livro = await this.livros.autorizado(tx, a, versaoAtual.livro_id);
        await numerarAta(tx, d, { conteudo: dto.conteudoSchema.parse(versaoAtual.conteudo) }, livro, contexto.orgao?.nome ?? contexto.nome);
      }
      if (operacao === 'encaminhar' && d.numero === null) {
        const ano = versaoAtual.data_documento.getUTCFullYear();
        const serie = { igreja_id: a.igreja_id, contexto_id: d.contexto_id, tipo: d.tipo, perfil: d.perfil, ano };
        const contador = await tx.contador_documento.upsert({ where: { igreja_id_contexto_id_tipo_perfil_ano: serie }, create: { ...serie, ultimo: 1 }, update: { ultimo: { increment: 1 } } });
        d.numero = contador.ultimo;
        d.ano = ano;
      }
      const { atual, entrada, config, c, vinculo, competenciaTermo } = await this.conferirAprovacao(tx, a, d, operacao === 'encaminhar');
      // Uma mudança de valor visível, inclusive a primeira numeração, altera a revisão lida.
      const salvos = (atual.conteudo as dto.VersaoInput['conteudo']).valores;
      const mudouTeor = d.tipo === 'ATA' && !isDeepStrictEqual(
        Object.fromEntries(Object.entries(salvos ?? {}).map(([id,c]) => [id,c.valor])),
        Object.fromEntries(Object.entries(entrada.conteudo.valores ?? {}).map(([id,c]) => [id,c.valor])));
      if (mudouTeor && operacao === 'aprovar') throw new ConflictException('Os campos da ata mudaram. Salve a minuta e delibere sobre a revisão atualizada.');
      if (operacao === 'encaminhar') {
        if (mudouTeor || atual.modelo?.finalidade === 'CONVOCACAO' || Object.values(config.definicoes ?? {}).some(campo => ehCampoNumeracao(campo.origem))) {
          await tx.documento_versao.update({ where: { id: atual.id }, data: { conteudo: json(entrada.conteudo), ...(mudouTeor && { revisao_conteudo: { increment: 1 } }) } });
        }
        await tx.documento.update({ where: { id }, data: { numero: d.numero, ano: d.ano, sigla: d.identificacao_livro ? null : d.sigla ?? c.orgao?.sigla ?? c.sigla, encaminhado_em: new Date(), revisao: { increment: 1 } } });
      } else {
        if (entrada.data_documento > await hojeDaIgreja(tx, a.igreja_id)) throw new BadRequestException('Documento futuro não pode ser aprovado.');
        this.conferirProntidao(d, atual);
        const aprovador = await this.base.competente(tx, a, d.contexto_id, 'pode_aprovar');
        const competenciasAprovador = (await this.base.concessoes(tx, a, d.contexto_id)).filter(c => c.pode_aprovar).map(c => c.id);
        const igreja = await tx.igreja.findUniqueOrThrow({ where: { id: a.igreja_id }, select: igrejaSelect });
        // Atualiza retratos sem trocar os arrolados usados pelas resoluções.
        const arrolados: typeof atual.arrolados = [];
        const porPessoa = new Map(atual.arrolados.map(p => [p.pessoa_id, p.id]));
        for (const p of entrada.conteudo.arrolados) {
          const retrato = await this.retratoArrolado(tx, a, c.orgao_id, p);
          arrolados.push(await tx.arrolado_documento.update({
            where: { id: porPessoa.get(p.pessoa_id)! }, data: { retrato: json(retrato) },
          }));
        }
        if (d.tipo === 'ATA' && atual.reuniao_id) {
          const origem = await this.cadastros.reuniao(tx,a,atual.reuniao_id);
          const consolidado = dadosConsolidadosAta(dto.reuniaoDadosSchema.parse(origem.dados),entrada.conteudo);
          const endereco=origem.local_efetivo_retrato as {descritivo?:string} | null;
          const mudouLocal=endereco && endereco.descritivo!==consolidado.local_efetivo;
          await tx.reuniao.update({where:{id:origem.id},data:{dados:json(consolidado),revisao:{increment:1},
            ...(mudouLocal && {local_efetivo_id:null,local_efetivo_retrato:Prisma.DbNull})}});
        }
        const reuniao = atual.reuniao_id ? await this.cadastros.reuniao(tx, a, atual.reuniao_id) : null;
        const numero = identificacaoDocumento(d);
        const nomeContexto = c.orgao?.nome ?? c.nome;
        const fonte = await this.artefatos.fonteMatriz(tx, d, { ...atual, conteudo: entrada.conteudo }, igreja, arrolados, numero, nomeContexto, vinculo);
        const reserva = vinculo ? await this.livros.reservar(tx, vinculo, atual, await this.artefatos.paginasMedidas(tx, d, atual, fonte)) : null;
        const paginacao = reserva && vinculo ? {
          ...reserva, numero_livro: vinculo.livro.numero, serie_livro: vinculo.livro.serie,
        } : null;
        if (reserva) this.artefatos.fixarPaginacao(fonte, reserva);
        await tx.documento_versao.update({ where: { id: atual.id }, data: { conteudo: json(entrada.conteudo), congelado_em: new Date(), fonte_congelada: json({ igreja, contexto: { id: c.id, tipo: c.tipo, nome: nomeContexto, sigla: d.sigla ?? c.orgao?.sigla ?? c.sigla, orgao: c.orgao ? { tipo: c.orgao.tipo, constituicao: c.orgao.constituicao } : null }, modelo: atual.modelo, numero, arrolados, anexos: atual.anexos, reuniao, ...(entrada.resolucoes.length ? { resolucoes: entrada.resolucoes } : {}), ...(paginacao ? { registro_livro: paginacao } : {}), ...(competenciaTermo ? { competencia_termo: competenciaTermo } : {}), deliberacao: atual.deliberacoes.at(-1) ?? null, aprovacao_tecnica: { usuario_id: a.sub, pessoa_id: aprovador.pessoa_id, nome: aprovador.nome_usuario, perfil: aprovador.perfil, competencias_ids: competenciasAprovador, autoridade: v.autoridade, evidencia: v.evidencia, data: new Date().toISOString() } }) } });
        if (modalidade) {
          const fuso = await tx.configuracao_fuso_igreja.findUnique({ where: { igreja_id: a.igreja_id } });
          await tx.expedicao_documento.create({ data: {
            versao_id: atual.id, igreja_id: a.igreja_id, contexto_id: d.contexto_id, operador_id: a.sub,
            modalidade, fuso_iana: fuso?.fuso_iana ?? 'UTC', codigo_verificacao: randomBytes(16).toString('hex'),
          } });
        }
        await this.artefatos.enfileirarMatriz(tx, a, d, atual, fonte);
        await tx.documento.update({ where: { id }, data: { estado: 'APROVADO', revisao: { increment: 1 } } });
      }
      return { id, revisao: d.revisao + 1 };
    });
  }

  deliberar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.deliberacaoSchema, dados);
    return this.base.comando(a, 'DELIBERAR_ATA', id, v, async tx => {
      const d = await this.base.documento(tx, a, id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      await this.base.competente(tx, a, d.contexto_id, 'pode_deliberar');
      if (d.tipo !== 'ATA' || d.estado !== 'EM_EDICAO') throw new BadRequestException('Deliberação exige ata em edição.');
      if (v.data > await hojeDaIgreja(tx, a.igreja_id)) throw new BadRequestException('Deliberação futura não pode ser registrada.');
      const atual = d.versoes.find(r => r.numero === d.versao_atual)!;
      const r = await this.cadastros.reuniao(tx, a, v.reuniao_id);
      const origem = await this.cadastros.reuniao(tx, a, atual.reuniao_id!);
      const registro = dto.validar(dto.reuniaoDadosSchema, r.dados);
      const rd = r.id===origem.id ? dadosConsolidadosAta(registro,dto.conteudoSchema.parse(atual.conteudo)) : registro;
      await this.cadastros.conferirConvocacao(tx,a,r.contexto_id,rd,r.id,registro);
      if (rd.situacao && !['EM_ANDAMENTO', 'ENCERRADA'].includes(rd.situacao))
        throw new BadRequestException('A reunião deliberativa exige realização registrada.');
      if (r.contexto_id !== d.contexto_id || r.data < origem.data || dataCivil(v.data).getTime() !== r.data.getTime() || (r.restrito && !d.restrito) || !rd.quorum_conferido || (rd.total_presentes ?? r.participantes.filter(p => p.presente).length) < rd.quorum_minimo) throw new BadRequestException('Reunião deliberativa, data, sigilo ou quórum incompatíveis.');
      for (const papel of ['PRESIDENTE', 'SECRETARIO']) if (!r.participantes.some(p => p.presente && p.papeis.includes(papel))) throw new BadRequestException('Mesa deliberativa incompleta.');
      const mesa = r.instalacao_formal ? await mesaVigente(tx, r) : null;
      if (r.instalacao_formal && !mesa) throw new BadRequestException('Instale a mesa da assembleia antes de registrar a deliberação.');
      await tx.deliberacao_ata.create({ data: { ...(mesa && { conferencia_votacao: json(conferirVotacao(mesa, r.participantes, rd.quorum_minimo, true)) }), mesa_id: mesa?.id, igreja_id: a.igreja_id, contexto_id: d.contexto_id, versao_id: atual.id, revisao_conteudo: atual.revisao_conteudo, reuniao_id: r.id, data: dataCivil(v.data), resultado: v.resultado, autoridade: v.autoridade, evidencia: v.evidencia } });
      await tx.documento.update({ where: { id }, data: { revisao: { increment: 1 } } });
      return { id, revisao: d.revisao + 1 };
    });
  }

  retificar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.retificarSchema, dados);
    return this.base.comando(a, 'RETIFICAR_DOCUMENTO', id, v, async tx => {
      const d = await this.base.documento(tx, a, id);
      await this.base.competente(tx, a, d.contexto_id, 'pode_aprovar');
      this.base.conferirRevisao(d.revisao, v.revisao);
      if (!['APROVADO', 'EXPEDIDO', 'ANULADO'].includes(d.estado)) throw new BadRequestException('Retificação exige versão aprovada ou expedida.');
      const atual = d.versoes.find(r => r.numero === d.versao_atual)!;
      if (atual.livro_id) exigirLivros();
      if (dto.finalidadeTermo(atual.modelo?.finalidade)) throw new BadRequestException('Cancele o termo pendente e crie um novo termo, ou vincule um ato complementar ao livro encerrado.');
      const versao = { ...v.versao, conteudo: structuredClone(v.versao.conteudo), resolucoes: v.versao.resolucoes ?? entradaResolucoes(atual.resolucoes) };
      const novoDocumento = d.estado === 'EXPEDIDO' || d.estado === 'ANULADO';
      const { m, config, vinculo, c } = await this.validarVersao(tx, a, d.contexto_id, id, versao, atual, d.restrito, novoDocumento ? null : d.numero, novoDocumento);
      if (m.finalidade === 'CONVOCACAO' && versao.reuniao_id) {
        const aberto = await this.cadastros.convocacaoEmCurso(tx, a, d.contexto_id, versao.reuniao_id);
        if (aberto && aberto.documento.id !== d.id) throw new ConflictException('Já existe uma convocação em andamento para esta reunião.');
      }
      if (novoDocumento || m.id !== atual.modelo_versao_id) await this.base.autorizarModelo(tx, a, d.contexto_id, m.configuracao, 'criar');
      if ((novoDocumento || !(atual.conteudo as dto.VersaoInput['conteudo']).composicao) &&
          (versao.conteudo.composicao || config.composicao_padrao)) exigirEditorPagina(d.contexto_id);
      if (dto.finalidadeTermo(m.finalidade)) throw new BadRequestException('Termo de livro deve ser criado como novo documento.');
      if (m.tipo !== d.tipo || (d.tipo === 'ATA' && config.perfil !== d.perfil)) throw new BadRequestException('Tipo e perfil devem ser preservados.');
      if (d.estado === 'EXPEDIDO' || d.estado === 'ANULADO') {
        const novo = await tx.documento.create({ data: { igreja_id: a.igreja_id, contexto_id: d.contexto_id, tipo: d.tipo, perfil: d.perfil, restrito: d.restrito } });
        await numerarAta(tx, novo, versao, vinculo?.livro, c.orgao?.nome ?? c.nome);
        const nova = await this.novaVersao(tx, a, novo.id, d.contexto_id, 1, versao, atual.id);
        if (d.tipo === 'ATA') await this.referencias.reatribuirNaEdicao(tx, a, id, novo.id, nova.id, v.reatribuicao_atos);
        return { id: novo.id, revisao: 1 };
      }
      if (d.ano && d.ano !== Number(v.versao.data_documento.slice(0, 4))) throw new BadRequestException('Ano reservado não pode mudar.');
      if (d.numero !== null && atual.livro_id !== (versao.livro_id ?? null)) throw new BadRequestException('Preserve o livro ao retificar a versão. Transfira a minuta após a retificação.');
      await cancelarExpedicao(tx, atual.id);
      if (atual.livro_id) await this.livros.cancelarReserva(tx, atual.id);
      const nova = await this.novaVersao(tx, a, id, d.contexto_id, d.versao_atual + 1, versao, atual.id);
      if (d.tipo === 'ATA') await this.referencias.reatribuirNaEdicao(tx, a, id, id, nova.id, v.reatribuicao_atos);
      await tx.documento.update({ where: { id }, data: { versao_atual: { increment: 1 }, revisao: { increment: 1 }, estado: 'EM_EDICAO', encaminhado_em: null } });
      return { id, revisao: d.revisao + 1 };
    });
  }

  private async modeloDestino(tx: Tx, a: AtorSecretaria, id: string, restrito: boolean) {
    const m = await tx.modelo_documento_versao.findFirst({ where: { id, igreja_id: a.igreja_id }, select: { contexto_id: true, configuracao: true, tipo: true } });
    if (!m) throw new BadRequestException('Modelo de destino indisponível.');
    await this.base.autorizarModelo(tx, a, m.contexto_id, m.configuracao, 'editar', true);
    if (restrito) {
      if (m.tipo === 'ATA') {
        if (!(await permissoesAtasDaConta(tx, a.igreja_id, a.sub)).get(m.contexto_id)?.ler)
          throw new ForbiddenException('Ata restrita indisponível neste contexto.');
      } else await this.base.competente(tx, a, m.contexto_id, 'pode_consultar_restritos');
    }
    return { contexto: m.contexto_id, tipo: m.tipo, config: dto.validar(dto.configuracaoSchema, m.configuracao) };
  }

  previaOrigem(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(z.strictObject({ modelo_versao_id: z.uuid(), origem_id: z.uuid(), reuniao_id: z.uuid().optional(), restrito: z.boolean(), excluir: z.uuid().optional() }), dados);
    return this.base.prisma.$transaction(async tx => {
      const { contexto, tipo, config } = await this.modeloDestino(tx, a, v.modelo_versao_id, v.restrito);
      await this.base.conferirMotivador(tx, a, v.origem_id, v.excluir ?? '');
      if (tipo === 'ATA') {
        if (!v.reuniao_id) throw new BadRequestException('Selecione a reunião da ata.');
        const reuniao = await this.cadastros.reuniao(tx, a, v.reuniao_id);
        if (reuniao.contexto_id !== contexto || (reuniao.restrito && !v.restrito)) throw new BadRequestException('Reunião incompatível com a ata.');
      }
      return copiarOrigem(tx, this.base, a, contexto, v.restrito, config, v.origem_id, false, tipo === 'ATA' ? v.reuniao_id : undefined);
    }, { isolationLevel: 'RepeatableRead' });
  }

  motivadores(a: AtorSecretaria, consulta: Record<string, string>) {
    const { excluir, restrito, modelo_destino, reuniao_id, ...filtros } = dto.validar(z.object({
      modelo_destino: z.uuid().optional(), reuniao_id: z.uuid().optional(), excluir: z.uuid().optional(), restrito: z.enum(['true', 'false']).optional(),
    }).catchall(z.string()), consulta);
    return this.base.prisma.$transaction(async tx => {
      const conta = await this.base.operador(tx, a);
      const juvenisRestritos = await orgaosJuvenisRestritos(tx, conta, await hojeDaIgreja(tx, a.igreja_id));
      const contextos = conta.perfil === 'COMUM' ? await tx.contexto_secretaria.findMany({ where: { igreja_id: a.igreja_id }, include: { orgao: true } }) : null;
      const visiveis = contextos && (await Promise.all(contextos.map(async c => ({ id: c.id, pode: await this.base.contextoVisivel(tx, c, conta) }))))
        .filter(c => c.pode).map(c => c.id);
      const autorizados = restrito === 'true' ? (await this.base.concessoes(tx, a)).filter(c => c.pode_consultar_restritos).map(c => c.contexto_id) : [];
      let encadeamento = Prisma.empty;
      let convocatorias = false;
      if (modelo_destino) {
        const { contexto, tipo, config } = await this.modeloDestino(tx, a, modelo_destino, restrito === 'true');
        const ids = await versoesElegiveis(tx, a.igreja_id, contexto, config);
        encadeamento = ids.length ? Prisma.sql`AND d.contexto_id = ${contexto} AND d.estado = 'EXPEDIDO' AND v.modelo_versao_id IN (${Prisma.join(ids)})` : Prisma.sql`AND false`;
        convocatorias = tipo === 'ATA';
        if (convocatorias) encadeamento = reuniao_id ? Prisma.sql`${encadeamento} AND v.reuniao_id = ${reuniao_id}
          AND EXISTS (SELECT 1 FROM reuniao r WHERE r.id = v.reuniao_id AND r.igreja_id = d.igreja_id AND r.contexto_id = d.contexto_id AND (NOT r.restrito OR ${autorizados.includes(contexto)}))
          AND EXISTS (SELECT 1 FROM modelo_documento_versao mv WHERE mv.id = v.modelo_versao_id AND mv.finalidade = 'CONVOCACAO')` : Prisma.sql`AND false`;
      }
      const atasRestritas = restrito === 'true' ? await contextosDasAtasRestritas(tx, a.igreja_id, a.sub) : [];
      return selecionarDocumentos(tx, Prisma.sql`${tabelasDocumentais}
        WHERE d.igreja_id = ${a.igreja_id} AND v.numero = d.versao_atual ${encadeamento}
        ${juvenisRestritos.length ? Prisma.sql`AND c.orgao_id NOT IN (${Prisma.join(juvenisRestritos)})` : Prisma.empty}
        ${visiveis ? visiveis.length ? Prisma.sql`AND c.id IN (${Prisma.join(visiveis)})` : Prisma.sql`AND false` : Prisma.empty}
        AND ${visibilidadeDocumentosSql(autorizados, atasRestritas)}
        ${excluir ? Prisma.sql`AND d.id <> ${excluir}` : Prisma.empty}`, filtros, convocatorias, autorizados);
    }, { isolationLevel: 'RepeatableRead' });
  }

  async listar(a: AtorSecretaria, contexto: string, pagina: number) {
    return (await this.consultar(a, { contexto, pagina, visao: 'todos' })).itens;
  }

  consultar(a: AtorSecretaria, parametros: unknown) {
    const { contexto, pagina, tipo, visao, modelo, estado, busca, de, ate } = dto.validar(dto.consultaDocumentosSchema, parametros);
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a, true);
      const { somenteAtas } = await this.base.contextoDeAtas(tx, a, contexto);
      const atasRestritas = await contextosDasAtasRestritas(tx, a.igreja_id, a.sub);
      const restritos = (await this.base.concessoes(tx, a, contexto)).some(g => g.pode_consultar_restritos);
      const linhas = await tx.$queryRaw<LinhaDocumento[]>`
        SELECT d.id, d.estado, d.revisao, d.versao_atual, d.tipo, d.numero, d.ano, d.sigla, d.identificacao_livro, d.criado_em,
               d.restrito, d.encaminhado_em, m.nome AS modelo_nome, v.id AS versao_id, v.numero_original, v.assunto, v.data_documento
        FROM documento d
        LEFT JOIN documento_versao v ON v.documento_id = d.id AND v.numero = d.versao_atual
          AND v.igreja_id = d.igreja_id AND v.contexto_id = d.contexto_id
        LEFT JOIN modelo_documento_versao mv ON mv.id = v.modelo_versao_id AND mv.igreja_id = d.igreja_id AND mv.contexto_id = d.contexto_id
        LEFT JOIN modelo_documento m ON m.id = mv.modelo_id AND m.igreja_id = mv.igreja_id AND m.contexto_id = mv.contexto_id
        WHERE d.igreja_id = ${a.igreja_id} AND d.contexto_id = ${contexto}
          ${tipo ? Prisma.sql`AND d.tipo = ${tipo}::documento_tipo` : Prisma.empty}
          ${visao === 'expedidos' ? Prisma.sql`AND d.estado = 'EXPEDIDO'` : visao === 'andamento' ? Prisma.sql`AND d.estado IN ('EM_EDICAO', 'APROVADO')` : Prisma.empty}
          ${estado === 'ENCAMINHADO' ? Prisma.sql`AND d.estado = 'EM_EDICAO' AND d.encaminhado_em IS NOT NULL` :
            estado === 'EM_EDICAO' ? Prisma.sql`AND d.estado = 'EM_EDICAO' AND d.encaminhado_em IS NULL` :
            estado ? Prisma.sql`AND d.estado::text = ${estado}` : Prisma.empty}
          ${busca ? Prisma.sql`AND (strpos(lower(v.assunto), lower(${busca})) > 0 OR ${buscaNumero(busca)})` : Prisma.empty}
          ${modelo ? Prisma.sql`AND m.id = ${modelo}` : Prisma.empty}
          ${de ? Prisma.sql`AND v.data_documento >= ${de}::date` : Prisma.empty}
          ${ate ? Prisma.sql`AND v.data_documento <= ${ate}::date` : Prisma.empty}
          ${somenteAtas ? Prisma.sql`AND d.tipo = 'ATA'` : Prisma.empty}
          AND ${visibilidadeDocumentosSql(restritos ? [contexto] : [], atasRestritas)}
        ORDER BY v.data_documento DESC NULLS LAST, d.id ASC
        LIMIT 31 OFFSET ${pagina * 30}
      `;
      const itens = linhas.slice(0, 30).map(({ versao_id, numero_original, assunto, data_documento, ...doc }) => ({
        ...doc,
        versoes: versao_id === null ? [] : [{ id: versao_id, numero: doc.versao_atual, numero_original, assunto, data_documento }],
      }));
      return { itens, tem_proxima: linhas.length > 30 };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async historico(a: AtorSecretaria, id: string, pagina: number) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a, true);
      await this.base.documento(tx, a, id);
      const comandos = await tx.comando_secretaria.findMany({ where: { igreja_id: a.igreja_id, OR: [{ alvo_id: id }, { resultado: { path: ['id'], equals: id } }] }, select: { id: true, operacao: true, criado_em: true, dados: true, usuario: { select: { nome_usuario: true } } }, orderBy: [{ criado_em: 'desc' }, { id: 'asc' }], take: 30, skip: pagina * 30 });
      return comandos.map(c => {
        const dados = c.dados as Record<string, unknown>;
        return { id: c.id, operacao: c.operacao, criado_em: c.criado_em, operador: c.usuario.nome_usuario, autoridade: typeof dados.autoridade === 'string' ? dados.autoridade : null, evidencia: typeof dados.evidencia === 'string' ? dados.evidencia : null };
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async detalhe(a: AtorSecretaria, id: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a, true);
      const d = await this.base.documento(tx, a, id);
      const { somenteAtas } = await this.base.contextoDeAtas(tx, a, d.contexto_id);
      await tx.logs_atividades.create({ data: { igreja_id: a.igreja_id, usuario_id: a.sub, acao: 'CONSULTA', tabela_afetada: 'documento', registro_id: id } });
      const atual = d.versoes.find(v => v.numero === d.versao_atual);
      const pendencias: PendenciaTramitacao[] = [];
      let atuacao: { criar: boolean; preparar: boolean } | undefined = a.perfil === 'COMUM' ? { criar: false, preparar: false } : undefined;
      let sugestoes_arrolados: dto.VersaoInput['conteudo']['arrolados'] | undefined;
      let dataFutura = false;
      if (!somenteAtas && d.estado === 'EM_EDICAO' && atual?.modelo) {
        dataFutura = atual.data_documento.toISOString().slice(0, 10) > await hojeDaIgreja(tx, a.igreja_id);
        const config = dto.configuracaoSchema.safeParse(atual.modelo.configuracao);
        const conteudo = dto.conteudoSchema.safeParse(atual.conteudo);
        if (config.success && conteudo.success) {
          if (config.data.atuacao) {
            const c = await this.base.contexto(tx, a, d.contexto_id);
            const u = await this.base.operador(tx, a);
            const pode = await this.base.podePreparar(tx, a, d.contexto_id, u);
            atuacao = permissoesModelo(config.data.atuacao, u.perfil === 'COMUM' ? await this.base.papeisContextuais(tx, c, u) : await this.base.atuacao.papeis(tx, c, pode ? u.pessoa_id : null));
            if (u.perfil === 'COMUM' && c.orgao.tipo === 'ASSEMBLEIA_GERAL') {
              const sessao = atual.reuniao_id ? { id: atual.reuniao_id, igreja_id: d.igreja_id, contexto_id: d.contexto_id } : null;
              atuacao = { criar: false, preparar: d.tipo === 'ATA' && atuacao.preparar && !(sessao && await mesaVigente(tx, sessao)) };
            }
            try {
              await this.base.atuacao.conferirAssinaturas(tx, c, config.data.atuacao, { modelo_versao_id: atual.modelo.id, data_documento: atual.data_documento.toISOString().slice(0, 10), reuniao_id: atual.reuniao_id, motivador_id: atual.motivador_id, assunto: atual.assunto, conteudo: conteudo.data });
            } catch (erro) {
              if (!(erro instanceof BadRequestException)) throw erro;
              pendencias.push({ destino: 'arrolados', mensagem: erro.message });
            }
          }
          pendencias.push(...pendenciasConteudo(config.data, conteudo.data, atual.motivador_id, atual.resolucoes.length, d.numero === null));
          if (livrosDisponiveis() && atual.modelo.finalidade === 'TERMO_ABERTURA' && atual.livro_id && config.data.papeis_obrigatorios.includes('SECRETARIO')) {
            const livro = await this.livros.autorizado(tx, a, atual.livro_id);
            const responsaveis = await this.livros.responsaveisAbertura(tx, await this.base.contexto(tx, a, d.contexto_id), livro,
              atual.data_documento.toISOString().slice(0, 10), config.data, conteudo.data.autores_origem?.preparador);
            try {
              this.livros.conferirSecretarioAbertura(responsaveis, conteudo.data.arrolados);
            } catch (erro) {
              if (!(erro instanceof BadRequestException)) throw erro;
              pendencias.push({ destino: 'arrolados', mensagem: erro.message });
            }
          }
          if (livrosDisponiveis() && atual.livro?.perfil === 'CONCILIO_IPB_2025' && dto.finalidadeTermo(atual.modelo.finalidade)) {
            try {
              await this.livros.conferirPresidenciaTermo(tx, a.igreja_id, atual.data_documento.toISOString().slice(0, 10), conteudo.data.arrolados);
            } catch (erro) {
              if (!(erro instanceof BadRequestException)) throw erro;
              pendencias.push({ destino: 'arrolados', mensagem: erro.message });
            }
          }
          if (livrosDisponiveis() && !atual.livro_id && (dto.finalidadeTermo(atual.modelo.finalidade) || dto.politicaLivro(config.data) === 'OBRIGATORIO')) {
            pendencias.push({ destino: 'livro', mensagem: 'Selecione um livro compatível.' });
          }
        }
        if (d.tipo === 'ATA' && atual.reuniao_id && conteudo.success && config.success) {
          try {
            const r = await this.cadastros.reuniao(tx, a, atual.reuniao_id);
            const dados = dto.reuniaoDadosSchema.safeParse(r.dados);
            pendencias.push(...pendenciasAssinaturasReuniao(config.data.assinaturas_reuniao, r.participantes, conteudo.data));
            sugestoes_arrolados = await this.base.atuacao.sugerirArrolados(tx, await this.base.contexto(tx, a, d.contexto_id),
              config.data, atual.data_documento.toISOString().slice(0,10), r.participantes);
            if (dados.success) pendencias.push(...pendenciasMesa(dadosConsolidadosAta(dados.data, conteudo.data), r.participantes, d.identificacao_livro || dados.data.situacao ? conteudo.data : undefined));
          } catch (erro) {
            if (erro instanceof BadRequestException) pendencias.push({ destino:'efetivos', mensagem:erro.message });
            else if (erro instanceof NotFoundException) pendencias.push({destino:'reuniao',mensagem:'Selecione uma reunião disponível.'});
            else throw erro;
          }
        }
      }
      return { ...d, atuacao, sugestoes_arrolados, tramitacao: { pendencias, data_futura: dataFutura, livros: livrosDisponiveis(), assinaturas: assinaturasDisponiveis() } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
