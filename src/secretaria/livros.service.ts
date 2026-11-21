import { selecionarDocumentos, tabelasDocumentais } from './selecao-documental';
import { cancelarExpedicao } from './expedicao-estado';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { livro_atas, livro_estado, Prisma, registro_livro_natureza } from '@prisma/client';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { z } from 'zod';
import { featureEnabled } from '../feature-flags/feature-flags';
import { createHash } from 'node:crypto';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { ComposicaoService } from '../orgaos/composicao.service';
import { arquivoSemVinculoDeExpedicao, PrivateStorageService } from '../private-storage/private-storage.service';
import { capacidadeEmFaces, faceDoLivro, reservarPosicao, termoDeLivro, totaisLivro } from './livro-paginacao';
import { AtorSecretaria, dataCivil, json, SecretariaBaseService, Tx } from './secretaria-base.service';
import * as dto from './secretaria.dto';

const cadastro = z.object({
  ...dto.chave,
  contexto_id: z.uuid(),
  serie: dto.codigo,
  numero: z.number().int().min(1).max(2147483647),
  capacidade_folhas: z.number().int().min(1).max(1000),
  faces_por_folha: z.union([z.literal(1), z.literal(2)]),
  fonte_normativa: dto.texto,
  restrito: z.boolean(),
});
const criarSchema = cadastro
  .extend({
    modalidade: z.enum(['PARA_ENCADERNACAO', 'ELETRONICO']),
    perfil: z.enum(['CONCILIO_IPB_2025', 'LOCAL_V1']),
    reserva_exame: z.number().int().nonnegative().max(2000),
  })
  .strict();
const importarSchema = cadastro
  .extend({
    data_historica: dto.dia,
    arquivo_historico_id: z.uuid(),
    autoridade: dto.nome,
    evidencia: dto.texto,
  })
  .strict();
const referenciaIPB = 'Manual Presbiteriano 2025, Regulamento para Confecção de Atas, arts. 2 a 8, 11 e 20.';
const transicaoSchema = dto.comandoSchema.extend({ motivo: dto.texto }).strict();
const complementoSchema = transicaoSchema.extend({ versao_id: z.uuid() }).strict();

type Documento = Awaited<ReturnType<SecretariaBaseService['documento']>>;
type Versao = Documento['versoes'][number];
type LivroVinculado = { livro: livro_atas; natureza: registro_livro_natureza };
type Transicao = 'suspender' | 'retomar' | 'preparar-encerramento' | 'desistir-encerramento';
const transicoes = {
  suspender: { de: ['ABERTO'], para: 'SUSPENSO' },
  retomar: { de: ['SUSPENSO'], para: 'ABERTO' },
  'preparar-encerramento': { de: ['ABERTO', 'SUSPENSO'], para: 'EM_ENCERRAMENTO' },
  'desistir-encerramento': { de: ['EM_ENCERRAMENTO'], para: 'ABERTO' },
} as const;

function bytesManifesto(manifesto: Prisma.JsonValue) {
  const ordenar = (valor: Prisma.JsonValue): Prisma.JsonValue => {
    if (Array.isArray(valor)) return valor.map(ordenar);
    if (!valor || typeof valor !== 'object') return valor;
    return Object.fromEntries(
      Object.keys(valor)
        .sort()
        .map((chave) => [chave, ordenar(valor[chave]!)]),
    );
  };
  return Buffer.from(JSON.stringify(ordenar(manifesto)), 'utf8');
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function livrosDisponiveis() {
  return featureEnabled('secretaria') && featureEnabled('livros');
}

export function exigirLivros() {
  if (!livrosDisponiveis()) throw new NotFoundException('Recurso de livros indisponível.');
}

@Injectable()
export class LivrosService {
  constructor(
    private readonly base: SecretariaBaseService,
    private readonly storage: PrivateStorageService,
    private readonly composicao: ComposicaoService,
  ) {}

  async autorizado(tx: Tx, a: AtorSecretaria, id: string) {
    const livro = await tx.livro_atas.findFirst({ where: { id, igreja_id: a.igreja_id } });
    if (
      !livro ||
      (livro.restrito &&
        !(await this.base.concessoes(tx, a, livro.contexto_id)).some((c) => c.pode_consultar_restritos))
    ) {
      throw new NotFoundException('Livro indisponível nesta igreja.');
    }
    return livro;
  }

  private registros(tx: Tx, id: string) {
    return tx.registro_livro.findMany({ where: { livro_id: id }, orderBy: { ordem: 'asc' } });
  }

  private async evento(
    tx: Tx,
    a: AtorSecretaria,
    livro: livro_atas,
    tipo: string,
    ato: { motivo: string; autoridade: string; evidencia: string },
  ) {
    const operador = await this.base.operador(tx, a);
    const competencias = await this.base.concessoes(tx, a, livro.contexto_id);
    await tx.evento_livro.create({
      data: {
        igreja_id: a.igreja_id,
        contexto_id: livro.contexto_id,
        livro_id: livro.id,
        operador_id: a.sub,
        tipo,
        ...ato,
        retrato: json({
          nome: operador.nome_usuario,
          perfil: operador.perfil,
          pessoa_id: operador.pessoa_id,
          competencias: competencias.filter((c) => c.pode_aprovar).map((c) => c.id),
        }),
      },
    });
  }

  private async identidade(tx: Tx, a: AtorSecretaria, v: z.infer<typeof cadastro>) {
    const contexto = await this.base.contexto(tx, a, v.contexto_id);
    if (v.restrito) await this.base.competente(tx, a, v.contexto_id, 'pode_consultar_restritos');
    if (
      await tx.livro_atas.findFirst({
        where: { igreja_id: a.igreja_id, contexto_id: v.contexto_id, serie: v.serie, numero: v.numero },
      })
    ) {
      throw new ConflictException('O número já pertence a esta série do titular.');
    }
    const { idempotencia: _, ...dados } = cadastro.parse(v);
    return { contexto, dados: { ...dados, igreja_id: a.igreja_id, titular: contexto.orgao?.nome ?? contexto.nome } };
  }

  criar(a: AtorSecretaria, dados: unknown) {
    exigirLivros();
    const v = dto.validar(criarSchema, dados);
    if (capacidadeEmFaces(v) <= 2 + v.reserva_exame)
      throw new BadRequestException(
        'Informe capacidade para os dois termos, a reserva de exame e ao menos uma face de ata.',
      );
    return this.criarComando(a, 'LIVRO_CRIAR', v, async (tx) => {
      await this.base.preparar(tx, a, v.contexto_id);
      const { contexto, dados } = await this.identidade(tx, a, v);
      if (
        v.perfil === 'CONCILIO_IPB_2025' &&
        (contexto.orgao?.tipo !== 'CONSELHO' ||
          v.modalidade !== 'PARA_ENCADERNACAO' ||
          v.capacidade_folhas < 50 ||
          v.capacidade_folhas > 100)
      ) {
        throw new BadRequestException(
          'O perfil de concílios exige Conselho, livro para encadernação e capacidade de 50 a 100 folhas.',
        );
      }
      const livro = await tx.livro_atas.create({
        data: {
          ...dados,
          fonte_normativa: v.perfil === 'CONCILIO_IPB_2025' ? referenciaIPB : dados.fonte_normativa,
          perfil: v.perfil,
          modalidade: v.modalidade,
          reserva_exame: v.reserva_exame,
        },
      });
      return { id: livro.id, revisao: livro.revisao };
    });
  }

  importar(a: AtorSecretaria, dados: unknown) {
    exigirLivros();
    const v = dto.validar(importarSchema, dados);
    return this.criarComando(a, 'LIVRO_IMPORTAR', v, async (tx) => {
      await this.base.competente(tx, a, v.contexto_id, 'pode_aprovar');
      const { dados } = await this.identidade(tx, a, v);
      if (v.data_historica > (await hojeDaIgreja(tx, a.igreja_id)))
        throw new BadRequestException('Data histórica posterior ao dia atual.');
      const arquivo = await tx.arquivo_privado.findFirst({
        where: {
          id: v.arquivo_historico_id,
          igreja_id: a.igreja_id,
          usuario_id: a.sub,
          artefatos_documento: { none: {} },
          anexos_documento: { none: {} },
          imagens_modelo: { none: {} },
          livros_historicos: { none: {} },
          registros_livro: { none: {} },
          ...arquivoSemVinculoDeExpedicao,
        },
      });
      if (!arquivo || (await this.storage.readVerified(arquivo)).subarray(0, 5).toString() !== '%PDF-') {
        throw new BadRequestException('Envie o PDF digitalizado ao armazenamento privado antes de cadastrar o acervo.');
      }
      const livro = await tx.livro_atas.create({
        data: {
          ...dados,
          perfil: 'ACERVO_HISTORICO',
          modalidade: 'FISICO_DIGITALIZADO',
          reserva_exame: 0,
          estado: 'ENCERRADO',
          arquivo_historico_id: arquivo.id,
          data_historica: dataCivil(v.data_historica),
        },
      });
      await this.evento(tx, a, livro, 'IMPORTAR_ACERVO', {
        autoridade: v.autoridade,
        evidencia: v.evidencia,
        motivo: 'Cadastro de acervo físico encerrado',
      });
      return { id: livro.id, revisao: livro.revisao };
    });
  }

  private async criarComando<T extends { contexto_id: string; idempotencia: string }>(
    a: AtorSecretaria,
    operacao: string,
    v: T,
    executar: (tx: Tx) => Promise<{ id: string; revisao: number }>,
  ) {
    try {
      return await this.base.comando(a, operacao, v.contexto_id, v, executar);
    } catch (erro) {
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        erro.code === 'P2002' &&
        Array.isArray(erro.meta?.target) &&
        erro.meta.target.includes('numero')
      ) {
        return this.base.comando(a, operacao, v.contexto_id, v, executar);
      }
      throw erro;
    }
  }

  listar(
    a: AtorSecretaria,
    contexto: string,
    pagina: number,
    vinculo?: { serie?: string; restrito: boolean; estado?: livro_estado; modalidade?: 'FISICO_DIGITALIZADO' },
  ) {
    exigirLivros();
    return this.base.prisma.$transaction(
      async (tx) => {
        await this.base.operador(tx, a);
        await this.base.contexto(tx, a, contexto);
        const podeRestritos = (await this.base.concessoes(tx, a, contexto)).some((c) => c.pode_consultar_restritos);
        if (vinculo?.restrito && !podeRestritos) return [];
        return tx.livro_atas.findMany({
          where: {
            igreja_id: a.igreja_id,
            contexto_id: contexto,
            ...(podeRestritos ? { restrito: vinculo?.restrito } : { restrito: false }),
            ...(vinculo ? { serie: vinculo.serie, modalidade: vinculo.modalidade, estado: vinculo.estado ?? { not: 'ENCERRADO' } } : {}),
          },
          select: {
            id: true,
            titular: true,
            serie: true,
            numero: true,
            estado: true,
            revisao: true,
            restrito: true,
            capacidade_folhas: true,
            faces_por_folha: true,
            modalidade: true,
            perfil: true,
          },
          orderBy: [{ numero: 'desc' }, { serie: 'asc' }],
          skip: pagina * 30,
          take: 30,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  detalhe(a: AtorSecretaria, id: string) {
    exigirLivros();
    return this.base.prisma.$transaction(
      async (tx) => {
        await this.base.operador(tx, a);
        const livro = await this.autorizado(tx, a, id);
        const registros = await tx.registro_livro.findMany({
          where: { livro_id: id },
          orderBy: { ordem: 'asc' },
          include: {
            versao: { select: { documento_id: true, numero: true, assunto: true } },
            arquivo: { select: { sha256: true } },
          },
        });
        const [termos, eventos, complementos, atasLegadas] = await Promise.all([
          tx.documento_versao.findMany({
            where: { livro_id: id, modelo: { finalidade: { in: ['TERMO_ABERTURA', 'TERMO_ENCERRAMENTO'] } } },
            select: {
              id: true,
              assunto: true,
              numero: true,
              modelo: { select: { finalidade: true } },
              documento: { select: { id: true, estado: true, versao_atual: true } },
            },
            orderBy: [{ data_documento: 'asc' }, { id: 'asc' }],
          }),
          tx.evento_livro.findMany({
            where: { livro_id: id },
            select: {
              id: true,
              tipo: true,
              motivo: true,
              autoridade: true,
              evidencia: true,
              retrato: true,
              criado_em: true,
            },
            orderBy: [{ criado_em: 'desc' }, { id: 'asc' }],
            take: 100,
          }),
          tx.complemento_livro.findMany({
            where: { livro_id: id },
            include: {
              versao: {
                select: { documento_id: true, numero: true, assunto: true, documento: { select: { estado: true } } },
              },
            },
            orderBy: { criado_em: 'asc' },
          }),
          tx.documento_versao.findMany({
            where: { livro_id: id, igreja_id: a.igreja_id, contexto_id: livro.contexto_id,
              legada_superada: false, documento: { estado: 'LEGADA_CONFERIDA', restrito: livro.restrito } },
            select: { documento_id: true, numero_original: true, assunto: true, data_documento: true, folhas_legadas: true },
            orderBy: [{ data_documento: 'asc' }, { numero_original: 'asc' }, { id: 'asc' }],
          }),
        ]);
        await tx.logs_atividades.create({
          data: {
            igreja_id: livro.igreja_id,
            usuario_id: a.sub,
            acao: 'CONSULTA',
            tabela_afetada: 'livro_atas',
            registro_id: id,
          },
        });
        const { manifesto: _, ...resumo } = livro;
        return {
          ...resumo,
          capacidade_faces: capacidadeEmFaces(livro),
          totais: livro.arquivo_historico_id ? null : totaisLivro(livro, registros),
          registros: registros.map((r) => ({
            ...r,
            inicio: faceDoLivro(livro, r.posicao_inicio),
            fim: faceDoLivro(livro, r.posicao_fim),
          })),
          termos,
          eventos,
          complementos,
          atas_legadas: atasLegadas,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  transicao(a: AtorSecretaria, id: string, acao: Transicao, dados: unknown) {
    exigirLivros();
    const v = dto.validar(transicaoSchema, dados);
    return this.base.comando(a, 'LIVRO_' + acao.toUpperCase(), id, v, async (tx) => {
      const livro = await this.autorizado(tx, a, id);
      await this.base.competente(tx, a, livro.contexto_id, 'pode_aprovar');
      this.base.conferirRevisao(livro.revisao, v.revisao);
      const regra = transicoes[acao];
      if (!regra.de.some((anterior) => anterior === livro.estado))
        throw new BadRequestException('Transição inválida para o estado atual do livro.');
      if (acao === 'preparar-encerramento') {
        const registros = await this.registros(tx, id);
        if (registros.some((r) => r.estado === 'RESERVADO'))
          throw new BadRequestException('Resolva todas as reservas antes de preparar o encerramento.');
        reservarPosicao(livro, registros, 'ENCERRAMENTO', 1);
      }
      if (acao === 'desistir-encerramento') {
        const termo = await this.termoAtual(tx, id, 'TERMO_ENCERRAMENTO');
        if (termo) {
          await cancelarExpedicao(tx, termo.id);
          await this.cancelarReserva(tx, termo.id);
          await tx.documento.update({
            where: { id: termo.documento_id },
            data: { estado: 'CANCELADO', revisao: { increment: 1 } },
          });
        }
      }
      const atualizado = await tx.livro_atas.update({
        where: { id },
        data: {
          estado: regra.para,
          revisao: { increment: 1 },
          motivo_encerramento: acao === 'preparar-encerramento' ? v.motivo : null,
        },
      });
      await this.evento(tx, a, livro, acao.toUpperCase(), {
        motivo: v.motivo,
        autoridade: v.autoridade,
        evidencia: v.evidencia,
      });
      return { id, revisao: atualizado.revisao };
    });
  }

  private async termoAtual(tx: Tx, livro: string, finalidade: string) {
    const termos = await tx.documento_versao.findMany({
      where: {
        livro_id: livro,
        modelo: { finalidade },
        documento: { estado: { notIn: ['CANCELADO', 'ANULADO'] } },
      },
      select: { id: true, documento_id: true, numero: true, documento: { select: { versao_atual: true } } },
    });
    return termos.find((t) => t.numero === t.documento.versao_atual);
  }

  async validarVinculo(
    tx: Tx,
    a: AtorSecretaria,
    contexto: string,
    restrito: boolean,
    modelo: NonNullable<Versao['modelo']>,
    config: dto.ConfiguracaoModelo,
    entrada: dto.VersaoInput,
    atualId?: string,
  ): Promise<LivroVinculado | null> {
    const termo = dto.finalidadeTermo(modelo.finalidade);
    if (termo && modelo.tipo !== 'OUTRO')
      throw new BadRequestException('Termos de abertura e encerramento devem ser documentos do tipo OUTRO.');
    if (entrada.livro_id || termo) exigirLivros();
    const politica = dto.politicaLivro(config);
    if (!entrada.livro_id) {
      if (termo || (livrosDisponiveis() && politica === 'OBRIGATORIO'))
        throw new BadRequestException('Selecione o livro para esta versão do documento.');
      return null;
    }
    if (!termo && politica === 'NAO_PERMITE') throw new BadRequestException('O modelo não permite registro em livro.');
    const livro = await this.autorizado(tx, a, entrada.livro_id);
    if (
      livro.contexto_id !== contexto ||
      livro.restrito !== restrito ||
      (modelo.tipo === 'ATA' && livro.serie !== config.perfil)
    ) {
      throw new BadRequestException('Titular, série ou classificação de acesso incompatível com o livro.');
    }
    const estado = termo === 'ABERTURA' ? 'EM_PREPARACAO' : termo === 'ENCERRAMENTO' ? 'EM_ENCERRAMENTO' : 'ABERTO';
    if (livro.estado !== estado)
      throw new BadRequestException(
        termo ? 'Termo incompatível com o estado do livro.' : 'Somente livros abertos recebem novas inclusões.',
      );
    if (termo) {
      const anterior = await this.termoAtual(tx, livro.id, modelo.finalidade);
      if (anterior && anterior.id !== atualId)
        throw new ConflictException('O livro já tem um termo ativo desta finalidade.');
      if (
        termo === 'ENCERRAMENTO' &&
        livro.aberto_em &&
        dataCivil(entrada.data_documento) < (await this.dataMinimaEncerramento(tx, livro.id))
      ) {
        throw new BadRequestException('Data de encerramento anterior a um registro efetivado.');
      }
    }
    const natureza =
      termo ??
      (modelo.tipo === 'ATA' ? 'ATA_ORIGINAL' : modelo.finalidade === 'TERMO_EXAME' ? 'EXAME' : 'OUTRO_AUTORIZADO');
    if (termo) Object.assign(entrada.conteudo.campos, await this.camposTermo(tx, livro, termo));
    return { livro, natureza };
  }

  private async dataMinimaEncerramento(tx: Tx, id: string) {
    const registro = await tx.documento_versao.findFirstOrThrow({
      where: { livro_id: id, registro_livro: { estado: 'EFETIVADO' } },
      orderBy: { data_documento: 'desc' },
      select: { data_documento: true },
    });
    return registro.data_documento;
  }

  async camposTermo(tx: Tx, livro: livro_atas, natureza: 'ABERTURA' | 'ENCERRAMENTO'): Promise<Record<string, string>> {
    const comuns = {
      NUMERO_LIVRO: String(livro.numero),
      CAPACIDADE_FOLHAS: String(livro.capacidade_folhas),
      TITULAR: livro.titular,
      SERIE_LIVRO: livro.serie,
      MODALIDADE_LIVRO: livro.modalidade === 'ELETRONICO' ? 'eletrônico' : 'para encadernação',
    };
    if (natureza === 'ABERTURA') return comuns;
    const registros = await this.registros(tx, livro.id);
    if (registros.some((r) => r.estado === 'RESERVADO' && r.natureza !== 'ENCERRAMENTO'))
      throw new BadRequestException('Há reservas pendentes no inventário.');
    const inventario = registros.filter((r) => r.natureza !== 'ENCERRAMENTO');
    const previsto = reservarPosicao(livro, inventario, 'ENCERRAMENTO', 1);
    const totais = totaisLivro(livro, [...inventario, { ...previsto, estado: 'EFETIVADO', natureza: 'ENCERRAMENTO' }]);
    const numerados = inventario.filter((r) => r.estado === 'EFETIVADO' && r.natureza !== 'ABERTURA');
    return {
      ...comuns,
      FOLHAS_UTILIZADAS: String(totais.folhas_utilizadas),
      PAGINAS_UTILIZADAS: String(totais.paginas_utilizadas),
      TOTAL_ATAS: String(totais.total_atas),
      SALDO_FOLHAS: String(totais.saldo_folhas),
      SALDO_FACES: String(totais.saldo_faces),
      INTERVALO_REGISTROS: numerados.length
        ? `${numerados[0].posicao_inicio - 1} a ${numerados.at(-1)!.posicao_fim - 1}`
        : 'sem páginas numeradas',
      MOTIVO_ENCERRAMENTO: livro.motivo_encerramento!,
    };
  }

  async conferirResponsabilidade(tx: Tx, vinculo: LivroVinculado, entrada: dto.VersaoInput) {
    if (vinculo.livro.perfil !== 'CONCILIO_IPB_2025' || !termoDeLivro(vinculo.natureza)) return;
    const { igreja_id } = vinculo.livro;
    const data = dataCivil(entrada.data_documento);
    const presidencia = await tx.presidencia_conselho.findMany({
      where: { igreja_id, inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] },
      select: { id: true, oficial: { select: { pessoa_id: true } } },
    });
    const presidente = presidencia.length === 1 && presidencia[0].oficial.pessoa_id;
    const composicao = await this.composicao.consultarNaTransacao(tx, igreja_id, 'CONSELHO', entrada.data_documento);
    if (
      !presidente ||
      !composicao.membros.some((p) => p.pessoa_id === presidente && !p.revisao_pendente) ||
      !entrada.conteudo.arrolados.some(
        (p) => p.pessoa_id === presidente && p.assina && p.obrigatorio && p.papeis.includes('PRESIDENTE'),
      )
    ) {
      throw new BadRequestException(
        'O termo do Conselho exige o presidente institucional em exercício como signatário obrigatório.',
      );
    }
    return { presidencia_id: presidencia[0].id, pessoa_id: presidente };
  }

  async fixarTermo(tx: Tx, vinculo: LivroVinculado | null) {
    if (!vinculo || !termoDeLivro(vinculo.natureza)) return;
    await tx.livro_atas.update({ where: { id: vinculo.livro.id }, data: { revisao: { increment: 1 } } });
  }

  async reservar(tx: Tx, vinculo: LivroVinculado, v: Versao, paginas: number) {
    const { livro, natureza } = vinculo;
    const posicao = reservarPosicao(livro, await this.registros(tx, livro.id), natureza, paginas);
    return tx.registro_livro.create({
      data: {
        ...posicao,
        natureza,
        igreja_id: livro.igreja_id,
        contexto_id: livro.contexto_id,
        livro_id: livro.id,
        versao_id: v.id,
      },
    });
  }

  async cancelarReserva(tx: Tx, versao: string) {
    await tx.registro_livro.updateMany({
      where: { versao_id: versao, estado: 'RESERVADO' },
      data: { estado: 'CANCELADO', cancelado_em: new Date() },
    });
  }

  candidatosComplemento(a: AtorSecretaria, id: string, pagina: number, filtros?: Record<string, string>) {
    exigirLivros();
    return this.base.prisma.$transaction(
      async (tx) => {
        await this.base.operador(tx, a);
        const livro = await this.autorizado(tx, a, id);
        await this.base.competente(tx, a, livro.contexto_id, 'pode_aprovar');
        if (livro.estado !== 'ENCERRADO')
          throw new BadRequestException('Atos complementares são vinculados ao acervo encerrado.');
        const escopo = Prisma.sql`${tabelasDocumentais}
          JOIN modelo_documento_versao m ON m.id = v.modelo_versao_id
        WHERE v.igreja_id = ${livro.igreja_id} AND v.contexto_id = ${livro.contexto_id} AND d.restrito = ${livro.restrito}
          AND d.estado IN ('APROVADO','EXPEDIDO') AND v.numero = d.versao_atual AND v.congelado_em IS NOT NULL AND v.livro_id IS NULL
          AND ((v.retifica_versao_id IS NULL AND m.finalidade IN ('TERMO_EXAME','RETIFICACAO')) OR EXISTS (
            SELECT 1 FROM registro_livro r WHERE r.livro_id = ${id} AND r.versao_id = v.retifica_versao_id AND r.estado = 'EFETIVADO'))
          AND NOT EXISTS (SELECT 1 FROM complemento_livro c WHERE c.livro_id = ${id} AND c.versao_id = v.id)
        `;
        if (filtros) return selecionarDocumentos(tx, escopo, filtros);
        const candidatos = await tx.$queryRaw<{ id: string; assunto: string; numero: number }[]>`
        SELECT v.id, v.assunto, v.numero ${escopo}
        ORDER BY d.criado_em DESC, v.id ASC
        LIMIT 30 OFFSET ${pagina * 30}`;
        return candidatos;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  complementar(a: AtorSecretaria, id: string, dados: unknown) {
    exigirLivros();
    const v = dto.validar(complementoSchema, dados);
    return this.base.comando(a, 'LIVRO_COMPLEMENTAR', id, v, async (tx) => {
      const livro = await this.autorizado(tx, a, id);
      await this.base.competente(tx, a, livro.contexto_id, 'pode_aprovar');
      this.base.conferirRevisao(livro.revisao, v.revisao);
      const versao = await tx.documento_versao.findFirst({
        where: { id: v.versao_id, igreja_id: livro.igreja_id, contexto_id: livro.contexto_id },
        include: { modelo: true, documento: true },
      });
      if (
        livro.estado !== 'ENCERRADO' ||
        !versao?.congelado_em ||
        !['APROVADO', 'EXPEDIDO'].includes(versao.documento.estado) ||
        versao.numero !== versao.documento.versao_atual ||
        versao.documento.restrito !== livro.restrito ||
        versao.livro_id ||
        !versao.modelo ||
        (versao.modelo.finalidade !== 'TERMO_EXAME' &&
          versao.modelo.finalidade !== 'RETIFICACAO' &&
          !versao.retifica_versao_id)
      ) {
        throw new BadRequestException(
          'Vincule uma versão aprovada de exame ou retificação do mesmo titular e classificação a um livro encerrado.',
        );
      }
      if (
        versao.retifica_versao_id &&
        !(await tx.registro_livro.findFirst({
          where: { livro_id: id, versao_id: versao.retifica_versao_id, estado: 'EFETIVADO' },
        }))
      ) {
        throw new BadRequestException('A versão retificada não integra este livro.');
      }
      const anterior = await tx.complemento_livro.findUnique({
        where: { livro_id_versao_id: { livro_id: id, versao_id: versao.id } },
      });
      if (anterior) throw new ConflictException('A versão já é um complemento deste livro.');
      await tx.complemento_livro.create({
        data: { livro_id: id, contexto_id: livro.contexto_id, igreja_id: livro.igreja_id, versao_id: versao.id },
      });
      await this.evento(tx, a, livro, 'COMPLEMENTAR', {
        motivo: v.motivo,
        autoridade: v.autoridade,
        evidencia: v.evidencia,
      });
      return { id, versao_id: versao.id };
    });
  }

  /**
   * Integração interna da expedição. E07 valida as assinaturas e chama este método na mesma transação que grava EXPEDIDO.
   * O artefato deve conter as faces destinadas ao livro. Comprovantes extras são arquivados à parte.
   */
  async efetivarExpedicao(tx: Tx, a: AtorSecretaria, versaoId: string, arquivoId: string) {
    exigirLivros();
    const registro = await tx.registro_livro.findFirst({
      where: { versao_id: versaoId, igreja_id: a.igreja_id },
      include: { livro: true, versao: { include: { documento: true } } },
    });
    if (!registro) {
      if (
        await tx.documento_versao.findFirst({
          where: { id: versaoId, igreja_id: a.igreja_id, livro_id: { not: null } },
        })
      )
        throw new BadRequestException('Versão vinculada sem reserva de livro.');
      return;
    }
    const { livro, natureza, versao } = registro;
    if (registro.estado === 'EFETIVADO' && registro.arquivo_id === arquivoId) return;
    if (
      registro.estado !== 'RESERVADO' ||
      versao.documento.estado !== 'EXPEDIDO' ||
      versao.documento.versao_atual !== versao.numero ||
      !versao.congelado_em
    ) {
      throw new BadRequestException('A efetivação exige a reserva da versão expedida.');
    }
    if ((natureza === 'ABERTURA' && livro.estado !== 'EM_PREPARACAO') ||
        (natureza === 'ENCERRAMENTO' && livro.estado !== 'EM_ENCERRAMENTO') ||
        (natureza !== 'ABERTURA' && natureza !== 'ENCERRAMENTO' && !['ABERTO', 'SUSPENSO'].includes(livro.estado))) {
      throw new BadRequestException('Estado do livro impede a efetivação desta reserva.');
    }
    const matriz = await tx.trabalho_renderizacao.findFirst({
      where: { versao_id: versaoId, finalidade: 'MATRIZ_APROVADA', estado: 'CONCLUIDO' },
      include: { arquivo: true },
    });
    if (!matriz?.arquivo) throw new BadRequestException('Matriz da reserva indisponível.');
    await this.storage.readVerified(matriz.arquivo);
    const arquivo = await tx.arquivo_privado.findFirstOrThrow({ where: { id: arquivoId, igreja_id: a.igreja_id } });
    const pdf = await PDFDocument.load(await this.storage.readVerified(arquivo));
    if (pdf.getPageCount() !== registro.posicao_fim - registro.posicao_inicio + 1)
      throw new BadRequestException('O artefato expedido diverge da paginação reservada.');
    const agora = new Date();
    await tx.registro_livro.update({
      where: { id: registro.id },
      data: { arquivo_id: arquivo.id, estado: 'EFETIVADO', efetivado_em: agora },
    });
    if (natureza === 'ABERTURA') {
      await tx.livro_atas.update({ where: { id: livro.id }, data: { estado: 'ABERTO', aberto_em: agora } });
    }
    if (natureza === 'ENCERRAMENTO') {
      const registros = await tx.registro_livro.findMany({
        where: { livro_id: livro.id, estado: 'EFETIVADO' },
        orderBy: { ordem: 'asc' },
        include: {
          arquivo: true,
          versao: { select: { documento_id: true, numero: true } },
        },
      });
      const totais = totaisLivro(livro, await this.registros(tx, livro.id));
      if (totais.pendencias || !registros.some((r) => r.natureza === 'ABERTURA'))
        throw new BadRequestException('Inventário de encerramento incompleto.');
      for (const r of registros) await this.storage.readVerified(r.arquivo!);
      const manifesto = {
        formato: 1,
        livro: {
          id: livro.id,
          titular: livro.titular,
          numero: livro.numero,
          serie: livro.serie,
          capacidade_folhas: livro.capacidade_folhas,
          faces_por_folha: livro.faces_por_folha,
          motivo: livro.motivo_encerramento,
        },
        totais,
        registros: registros.map((r) => ({
          ordem: r.ordem,
          natureza: r.natureza,
          posicao_inicio: r.posicao_inicio,
          posicao_fim: r.posicao_fim,
          numero_visivel_inicio: r.numero_visivel_inicio,
          documento_id: r.versao.documento_id,
          versao_id: r.versao_id,
          versao: r.versao.numero,
          arquivo_id: r.arquivo_id,
          sha256: r.arquivo!.sha256,
        })),
      };
      await tx.livro_atas.update({
        where: { id: livro.id },
        data: {
          estado: 'ENCERRADO',
          encerrado_em: agora,
          manifesto: json(manifesto),
          manifesto_sha256: sha256(bytesManifesto(manifesto)),
        },
      });
    }
  }

  async baixarRegistro(a: AtorSecretaria, id: string, registroId: string) {
    exigirLivros();
    const item = await this.base.prisma.$transaction(
      async (tx) => {
        await this.base.operador(tx, a);
        const livro = await this.autorizado(tx, a, id);
        return tx.registro_livro.findFirst({
          where: { id: registroId, livro_id: livro.id, igreja_id: livro.igreja_id, estado: 'EFETIVADO' },
          include: { arquivo: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (!item?.arquivo) throw new NotFoundException('Original indisponível.');
    return this.storage.readAuthorized(a, item.arquivo);
  }

  async baixar(a: AtorSecretaria, id: string, tipo: 'historico' | 'manifesto' | 'compilacao') {
    exigirLivros();
    const livro = await this.base.prisma.$transaction(
      async (tx) => {
        await this.base.operador(tx, a);
        await this.autorizado(tx, a, id);
        return tx.livro_atas.findUniqueOrThrow({
          where: { id },
          include: {
            arquivo_historico: true,
            registros: { where: { estado: 'EFETIVADO' }, orderBy: { ordem: 'asc' }, include: { arquivo: true } },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (tipo === 'historico' && livro.arquivo_historico) return this.storage.readAuthorized(a, livro.arquivo_historico);
    if (livro.estado !== 'ENCERRADO' || !livro.manifesto || tipo === 'historico') {
      throw new NotFoundException('Arquivo indisponível no acervo.');
    }
    const manifesto = bytesManifesto(livro.manifesto);
    if (sha256(manifesto) !== livro.manifesto_sha256)
      throw new ConflictException('Integridade do manifesto de fechamento inválida.');
    const dadosManifesto = livro.manifesto as { registros: { arquivo_id: string; sha256: string }[] };
    if (
      dadosManifesto.registros.length !== livro.registros.length ||
      livro.registros.some(
        (r, i) =>
          r.arquivo?.id !== dadosManifesto.registros[i].arquivo_id ||
          r.arquivo.sha256 !== dadosManifesto.registros[i].sha256,
      )
    ) {
      throw new ConflictException('Os artefatos divergem do manifesto de fechamento.');
    }
    let resposta: Buffer;
    if (tipo === 'manifesto') {
      resposta = manifesto;
    } else {
      if (livro.registros.reduce((total, r) => total + (r.arquivo?.tamanho ?? 0), 0) > 50 * 1024 * 1024) {
        throw new BadRequestException(
          'A compilação excede 50 MB. Os originais continuam disponíveis no índice do livro.',
        );
      }
      const compilacao = await PDFDocument.create();
      const capa = compilacao.addPage();
      const fonte = await compilacao.embedFont(StandardFonts.Helvetica);
      capa.drawText('Compilação para leitura', { x: 50, y: 760, size: 20, font: fonte });
      capa.drawText(`Livro ${livro.numero} - ${livro.serie}`, { x: 50, y: 725, size: 12, font: fonte });
      capa.drawText('Consulte os arquivos originais para verificar assinaturas.', {
        x: 50,
        y: 700,
        size: 11,
        font: fonte,
      });
      let posicao = 1;
      for (const r of livro.registros) {
        const original = await PDFDocument.load(await this.storage.readVerified(r.arquivo!));
        const paginas = await compilacao.copyPages(original, original.getPageIndices());
        if (r.posicao_inicio < posicao || paginas.length !== r.posicao_fim - r.posicao_inicio + 1)
          throw new ConflictException('Posições do acervo divergentes.');
        for (; posicao < r.posicao_inicio; posicao++)
          compilacao.addPage([paginas[0].getWidth(), paginas[0].getHeight()]);
        for (const pagina of paginas) compilacao.addPage(pagina);
        posicao += paginas.length;
      }
      resposta = Buffer.from(await compilacao.save());
    }
    await this.base.prisma.logs_atividades.create({
      data: {
        igreja_id: a.igreja_id,
        usuario_id: a.sub,
        acao: 'DOWNLOAD',
        tabela_afetada: 'livro_atas',
        registro_id: id,
        dados_novos: { tipo },
      },
    });
    return resposta;
  }
}
