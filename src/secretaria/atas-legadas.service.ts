import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { execFile } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { arquivoSemVinculoDeExpedicao, PrivateStorageService } from '../private-storage/private-storage.service';
import { ataLegadaSchema, editarAtaLegadaSchema, type CamposAtaLegada, livroAtaLegadaSchema, teorAtaLegadaSchema } from './ata-legada.dto';
import { DocumentosService } from './documentos.service';
import { exigirLivros } from './livros.service';
import { salvarResolucoes } from './resolucoes';
import { SecretariaBaseService, dataCivil, json, type AtorSecretaria, type Tx } from './secretaria-base.service';
import { SecretariaCadastrosService } from './secretaria-cadastros.service';
import { validar, type VersaoInput } from './secretaria.dto';

type DadosAta = Omit<CamposAtaLegada, 'revisao' | 'idempotencia'>;
type FonteLegada = { numero: string | null; legado: { sha256: string; arquivo_id: string; reuniao: DadosAta['reuniao'] } };

@Injectable()
export class AtasLegadasService {
  constructor(
    private readonly base: SecretariaBaseService,
    private readonly cadastros: SecretariaCadastrosService,
    private readonly documentos: DocumentosService,
    private readonly storage: PrivateStorageService,
  ) {}

  private async pdf(tx: Tx, a: AtorSecretaria, id: string) {
    const arquivo = await tx.arquivo_privado.findFirst({
      where: {
        id,
        igreja_id: a.igreja_id,
        usuario_id: a.sub,
        anexos_documento: { none: {} },
        imagens_modelo: { none: {} },
        artefatos_documento: { none: {} },
        livros_historicos: { none: {} },
        registros_livro: { none: {} },
        ...arquivoSemVinculoDeExpedicao,
      },
    });
    if (!arquivo) throw new NotFoundException('Envie um PDF original para esta ata.');
    const bytes = await this.storage.readVerified(arquivo);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('Envie um arquivo PDF válido.');
    return { arquivo, bytes };
  }

  async extrairTeor(a: AtorSecretaria, dados: unknown) {
    const v = validar(teorAtaLegadaSchema, dados);
    const { bytes } = await this.base.prisma.$transaction(async (tx) => {
      await this.base.competente(tx, a, v.contexto_id, 'pode_aprovar');
      return this.pdf(tx, a, v.arquivo_id);
    });
    const teor = await new Promise<string>((resolve, reject) => {
      const processo = execFile(
        'pdftotext',
        ['-layout', '-enc', 'UTF-8', '-', '-'],
        {
          timeout: 8000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        },
        (erro, texto) => {
          if (!erro) return resolve(texto.replace(/\f/g, '\n\n').trim());
          if (erro.code === 'ENOENT')
            return reject(
              new ServiceUnavailableException(
                'Extração indisponível no servidor. Insira o teor conferido no formulário.',
              ),
            );
          reject(new BadRequestException('Não foi possível extrair o teor deste PDF. Insira a transcrição conferida.'));
        },
      );
      processo.stdin?.on('error', () => {
        /* A falha é reportada pelo callback do processo. */
      });
      processo.stdin?.end(bytes);
    });
    if (!teor)
      throw new BadRequestException(
        'O PDF não contém texto selecionável. Insira a transcrição conferida da digitalização.',
      );
    if (teor.length > 200000)
      throw new BadRequestException(
        'O teor excede 200 mil caracteres. Confira se o PDF contém apenas a ata selecionada.',
      );
    return { teor };
  }

  private async validarDados(tx: Tx, a: AtorSecretaria, contextoId: string, restrito: boolean, v: DadosAta) {
    const contexto = await this.base.contexto(tx, a, contextoId);
    if (v.data_documento > (await hojeDaIgreja(tx, a.igreja_id)))
      throw new BadRequestException('A data da ata legada não pode ser futura.');
    const reuniao = v.reuniao_id ? await this.cadastros.reuniao(tx, a, v.reuniao_id) : null;
    const dadosReuniao = reuniao?.dados as { local?: string } | undefined;
    const dataReuniao = reuniao?.data.toISOString().slice(0, 10) ?? v.reuniao.data;
    if (
      reuniao &&
      (reuniao.contexto_id !== contextoId ||
        (reuniao.restrito && !restrito) ||
        (dataReuniao && dataReuniao > v.data_documento) ||
        (v.reuniao.data && dataReuniao !== v.reuniao.data) ||
        (v.reuniao.modalidade && reuniao.modalidade !== v.reuniao.modalidade) ||
        (v.reuniao.local && v.reuniao.local !== dadosReuniao?.local))
    ) {
      throw new BadRequestException('A reunião vinculada tem contexto, sigilo ou dados incompatíveis com a ata.');
    }
    if (v.reuniao.modalidade) this.cadastros.validarModalidadeReuniao(contexto, v.reuniao.modalidade);
    const ids = v.arrolados.map((p) => p.pessoa_id);
    if ((await tx.pessoas.count({ where: { igreja_id: a.igreja_id, id: { in: ids } } })) !== ids.length) {
      throw new BadRequestException('Arrole somente pessoas cadastradas nesta igreja.');
    }
    return { contexto, reuniao, dataReuniao, dadosReuniao };
  }

  private async conferirIdentificacao(tx: Tx, escopo: { igreja_id: string; contexto_id: string }, v: DadosAta, sha256: string, excluir?: string) {
    const repetida = await tx.documento_versao.findFirst({
      where: {
        ...escopo, legada_superada: false,
        ...(excluir ? { documento_id: { not: excluir } } : {}),
        modelo_versao_id: null,
        data_documento: dataCivil(v.data_documento),
        ...(v.numero_original
          ? { numero_original: v.numero_original }
          : {
              numero_original: null,
              assunto: v.assunto,
              anexos: { some: { arquivo: { sha256 } } },
            }),
      },
      select: { id: true },
    });
    if (repetida) throw new ConflictException('Já há uma ata legada com essa identificação e data no contexto.');
  }

  private conteudo(v: DadosAta, anexos: VersaoInput['conteudo']['anexos']): VersaoInput['conteudo'] {
    return {
      teor: v.teor,
      campos: {},
      anexos,
      arrolados: v.arrolados.map((p) => ({
        ...p,
        cargo_id: null,
        cargos_ids: [],
        assina: false,
        obrigatorio: false,
        responsavel: false,
      })),
    };
  }

  criar(a: AtorSecretaria, dados: unknown) {
    const v = validar(ataLegadaSchema, dados);
    return this.base
      .comando(a, 'CRIAR_DOCUMENTO_LEGADO', v.contexto_id, v, async (tx) => {
        const operador = await this.base.competente(tx, a, v.contexto_id, 'pode_aprovar');
        if (v.restrito) await this.base.competente(tx, a, v.contexto_id, 'pode_consultar_restritos');
        const { contexto, reuniao, dadosReuniao, dataReuniao } = await this.validarDados(tx, a, v.contexto_id, v.restrito, v);
        const { arquivo, bytes } = await this.pdf(tx, a, v.pdf.arquivo_id);
        const pdf = await PDFDocument.load(bytes).catch(() => {
          throw new BadRequestException('Envie um PDF válido e sem senha.');
        });
        if (pdf.getPageCount() === 0) throw new BadRequestException('O PDF precisa conter ao menos uma página.');
        const escopo = { igreja_id: a.igreja_id, contexto_id: v.contexto_id };
        const dataDocumento = dataCivil(v.data_documento);
        await this.conferirIdentificacao(tx, escopo, v, arquivo.sha256);
        const d = await tx.documento.create({
          data: {
            ...escopo,
            tipo: 'ATA',
            perfil: 'ATA_LEGADA',
            estado: 'LEGADA_CONFERIDA',
            restrito: v.restrito,
          },
        });
        const conteudo = this.conteudo(v, [v.pdf]);
        const agora = new Date();
        const versao = await tx.documento_versao.create({
          data: {
            ...escopo,
            documento_id: d.id,
            numero: 1,
            numero_original: v.numero_original,
            reuniao_id: reuniao?.id,
            assunto: v.assunto,
            data_documento: dataDocumento,
            conteudo: json(conteudo),
            fonte_congelada: json({
              numero: v.numero_original,
              contexto: { nome: contexto.orgao?.nome ?? contexto.nome },
              legado: {
                autoridade: v.autoridade,
                evidencia: v.evidencia,
                conferido_em: agora,
                operador: operador.nome_usuario,
                arquivo_id: arquivo.id,
                sha256: arquivo.sha256,
                reuniao: {
                  ...v.reuniao,
                  data: dataReuniao,
                  local: v.reuniao.local ?? dadosReuniao?.local ?? null,
                  modalidade: reuniao?.modalidade ?? v.reuniao.modalidade,
                },
              },
            }),
          },
        });
        await this.documentos.salvarArroladosAnexos(tx, a, versao.id, v.contexto_id, conteudo);
        await salvarResolucoes(tx, { ...escopo, versao_id: versao.id }, v.resolucoes);
        await tx.documento_versao.update({ where: { id: versao.id }, data: { congelado_em: agora } });
        return { id: d.id, revisao: d.revisao };
      })
      .catch((erro: unknown) => {
        if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002') {
          throw new ConflictException(
            'Já existe uma ata com essa identificação ou uma operação concorrente. Confira o cadastro.',
          );
        }
        throw erro;
      });
  }

  editar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = validar(editarAtaLegadaSchema, dados);
    return this.base.comando(a, 'EDITAR_DOCUMENTO_LEGADO', id, v, async tx => {
      const operador = await this.base.operador(tx, a);
      this.base.exigirSecretario(operador);
      const d = await this.base.documento(tx, a, id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      const atual = d.versoes.find(r => r.numero === d.versao_atual);
      if (d.estado !== 'LEGADA_CONFERIDA' || !atual || atual.modelo_versao_id !== null)
        throw new BadRequestException('Selecione uma ata legada conferida.');
      const fonte = atual.fonte_congelada as unknown as FonteLegada;
      const original = atual.anexos.find(anexo => anexo.arquivo_id === fonte.legado.arquivo_id);
      if (!original || original.arquivo.sha256 !== fonte.legado.sha256)
        throw new ConflictException('O PDF original da ata não pôde ser identificado.');

      if (v.reuniao_id && v.reuniao_id === atual.reuniao_id)
        await this.corrigirReuniaoVinculada(tx, a, id, v.reuniao_id, fonte.legado.reuniao, v.reuniao);
      const { reuniao, dataReuniao, dadosReuniao } = await this.validarDados(tx, a, d.contexto_id, d.restrito, v);
      const escopo = { igreja_id: a.igreja_id, contexto_id: d.contexto_id };
      await this.conferirIdentificacao(tx, escopo, v, original.arquivo.sha256, id);
      const anexos = atual.anexos.map(({ arquivo_id, nome }) => ({ arquivo_id, nome }));
      const anterior = atual.conteudo as unknown as VersaoInput['conteudo'];
      const conteudo = { ...anterior, ...this.conteudo(v, anexos), campos: anterior.campos };
      const agora = new Date();
      await tx.documento_versao.update({ where: { id: atual.id }, data: { legada_superada: true } });
      const nova = await tx.documento_versao.create({ data: {
        ...escopo, documento_id: id, numero: atual.numero + 1, retifica_versao_id: atual.id,
        numero_original: v.numero_original, assunto: v.assunto, data_documento: dataCivil(v.data_documento),
        livro_id: atual.livro_id, folhas_legadas: atual.folhas_legadas, reuniao_id: v.reuniao_id,
        conteudo: json(conteudo), fonte_congelada: json({ ...fonte, numero: v.numero_original,
          legado: { ...fonte.legado, reuniao: { ...fonte.legado.reuniao, ...v.reuniao, data: dataReuniao,
            local: v.reuniao.local ?? dadosReuniao?.local ?? null, modalidade: reuniao?.modalidade ?? v.reuniao.modalidade } },
        }),
      } });
      await this.documentos.salvarArroladosAnexos(tx, a, nova.id, d.contexto_id, conteudo);
      await salvarResolucoes(tx, { ...escopo, versao_id: nova.id }, v.resolucoes);
      await tx.documento_versao.update({ where: { id: nova.id }, data: { congelado_em: agora } });
      const doc = await tx.documento.update({ where: { id }, data: { versao_atual: nova.numero, revisao: { increment: 1 } } });
      return { id, revisao: doc.revisao, versao_id: nova.id };
    }).catch((erro: unknown) => {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002')
        throw new ConflictException('Já existe uma ata com essa identificação e data no contexto.');
      throw erro;
    });
  }

  private async corrigirReuniaoVinculada(tx: Tx, a: AtorSecretaria, documento: string, id: string,
    anterior: DadosAta['reuniao'], nova: DadosAta['reuniao']) {
    const alterados = Object.entries(nova).filter(([campo, valor]) => valor !== (anterior[campo as keyof typeof anterior] ?? null));
    if (!alterados.length) return;
    const r = await this.cadastros.reuniao(tx, a, id);
    if (await tx.documento_versao.count({ where: { reuniao_id: id, documento_id: { not: documento } } })
      || await tx.deliberacao_ata.count({ where: { reuniao_id: id } }))
      throw new ConflictException('A reunião também integra outro ato. Selecione a reunião correta ou desfaça o vínculo para corrigir somente a ata.');
    const dados = { ...(r.dados as Record<string, unknown>), ...Object.fromEntries(alterados) };
    const data = nova.data ?? r.data.toISOString().slice(0, 10);
    const modalidade = nova.modalidade ?? r.modalidade;
    if (alterados.some(([campo, valor]) => ['data', 'modalidade', 'local', 'pauta'].includes(campo) && !valor))
      throw new BadRequestException('A reunião vinculada precisa manter data, modalidade, local e pauta.');
    await tx.reuniao.update({ where: { id }, data: { data: dataCivil(data), modalidade, dados: json(dados), revisao: { increment: 1 } } });
  }

  vincularLivro(a: AtorSecretaria, id: string, dados: unknown) {
    exigirLivros();
    const v = validar(livroAtaLegadaSchema, dados);
    return this.base.comando(a, 'VINCULAR_LIVRO_DOCUMENTO_LEGADO', id, v, async (tx) => {
      const d = await this.base.documento(tx, a, id);
      await this.base.competente(tx, a, d.contexto_id, 'pode_aprovar');
      this.base.conferirRevisao(d.revisao, v.revisao);
      const versao = d.versoes.find((s) => s.numero === d.versao_atual);
      if (d.estado !== 'LEGADA_CONFERIDA' || !versao)
        throw new BadRequestException('Selecione uma ata legada conferida.');
      if (
        v.livro_id &&
        !(await tx.livro_atas.findFirst({
          where: {
            id: v.livro_id,
            igreja_id: a.igreja_id,
            contexto_id: d.contexto_id,
            restrito: d.restrito,
            estado: 'ENCERRADO',
            modalidade: 'FISICO_DIGITALIZADO',
          },
          select: { id: true },
        }))
      )
        throw new BadRequestException('Selecione um livro físico digitalizado do mesmo contexto e classificação.');
      if (versao.livro_id === v.livro_id && versao.folhas_legadas === v.folhas) return { id, revisao: d.revisao };
      await tx.documento_versao.update({
        where: { id: versao.id },
        data: { livro_id: v.livro_id, folhas_legadas: v.folhas },
      });
      await tx.documento.update({ where: { id }, data: { revisao: { increment: 1 } } });
      return { id, revisao: d.revisao + 1 };
    });
  }
}
