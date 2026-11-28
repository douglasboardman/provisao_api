import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PDFDocument, PDFName } from 'pdf-lib';
import { hashAto } from '../orgaos/idempotencia';
import { LIMITE_ARTEFATO_EXPEDICAO } from '../private-storage/private-storage.service';
import { featureEnabled } from '../feature-flags/feature-flags';
import {
  atualAprovada,
  carimbarPdf,
  Expedicao,
  ExpedicaoArquivos,
  incluirExpedicao,
  nomeSignatario,
  obrigatoriosAtendidos,
} from './expedicao-arquivos';
import { assinaturasDisponiveis } from './expedicao-estado';
import { livrosDisponiveis, LivrosService } from './livros.service';
import { imprimirComprovante } from './renderizador';
import { SecretariaBaseService, json } from './secretaria-base.service';

const limite = 4;
const indisponivel = () =>
  new ServiceUnavailableException('Não foi possível confirmar a integridade do original arquivado.');
const metadados = (file: { id: string; sha256: string; tamanho: number }) => ({
  id: file.id,
  sha256: file.sha256,
  tamanho: file.tamanho,
});

@Injectable()
export class ExpedicaoWorkerService {
  constructor(
    private readonly base: SecretariaBaseService,
    private readonly arquivos: ExpedicaoArquivos,
    private readonly livros: LivrosService,
  ) {}

  private reservar(lease: string) {
    return this.base.prisma.$transaction(async (tx) => {
      const agora = new Date();
      await tx.expedicao_documento.updateMany({
        where: { estado: 'PROCESSANDO', reserva_ate: { lte: agora }, tentativas: { gte: limite } },
        data: { estado: 'FALHOU', reserva_id: null, reserva_ate: null },
      });
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT e.id FROM expedicao_documento e
          JOIN documento_versao v ON v.id = e.versao_id
        WHERE (v.livro_id IS NULL OR ${livrosDisponiveis()})
          AND ((e.estado = 'PENDENTE' AND e.executar_apos <= NOW())
            OR (e.estado = 'PROCESSANDO' AND e.reserva_ate <= NOW() AND e.tentativas < ${limite}))
        ORDER BY e.criado_em, e.id FOR UPDATE OF e SKIP LOCKED LIMIT 1`;
      if (!row) return null;
      return tx.expedicao_documento.update({
        where: { id: row.id },
        data: {
          estado: 'PROCESSANDO',
          reserva_id: lease,
          reserva_ate: new Date(Date.now() + 180_000),
          tentativas: { increment: 1 },
        },
        include: incluirExpedicao,
      });
    });
  }

  private async preparar(e: Expedicao) {
    if (
      !atualAprovada(e) ||
      !obrigatoriosAtendidos(e) ||
      e.assinaturas.some((a) => a.metodo !== e.modalidade || a.manifesto_sha256 !== e.aceite_sha256)
    ) {
      throw new Error('Versão ou assinaturas incompletas.');
    }
    const matriz = await this.arquivos.verificarAceite(e);
    const eletronicamente = e.modalidade === 'ELETRONICA';
    if (!eletronicamente && !e.conferencia) throw new Error('Conferência física ausente.');
    if (e.via) await this.arquivos.storage.readVerified(e.via);
    const faces = eletronicamente
      ? await carimbarPdf(matriz, `VIA ELETRÔNICA EXPEDIDA - VERIFICAÇÃO ${e.codigo_verificacao}`)
      : await this.arquivos.storage.readVerified(e.conferencia!.arquivo);

    const numero = (e.versao.fonte_congelada as { numero: string }).numero;
    const fuso = new Intl.DateTimeFormat('pt-BR', {
      timeZone: e.fuso_iana,
      dateStyle: 'short',
      timeStyle: 'medium',
    });
    const dados = [
      `Documento ${numero} · Versão ${e.versao.numero}`,
      `Código de verificação no ProVisão: ${e.codigo_verificacao}`,
      `SHA-256 da matriz aprovada: ${e.matriz!.sha256}`,
      `SHA-256 do manifesto de aceite: ${e.aceite_sha256}`,
    ];
    if (e.conferencia)
      dados.push(
        `Digitalização conferida por ${e.conferencia.operador_nome} em ${fuso.format(e.conferencia.conferida_em)} (${e.fuso_iana}).`,
        `SHA-256 da digitalização original: ${e.conferencia.arquivo.sha256}`,
      );
    const comprovante = await imprimirComprovante(
      eletronicamente ? 'Comprovante de assinaturas eletrônicas' : 'Comprovante de conferência física',
      dados,
      e.assinaturas.map((a) => ({
        nome: nomeSignatario(a.arrolado),
        detalhe: eletronicamente
          ? `${fuso.format(a.registrada_em)} (${e.fuso_iana}) · ${a.registrada_em.toISOString()} · Consentimento via convite individual`
          : `Assinatura física em ${(a.evidencias as { data_fisica: string }).data_fisica.split('-').reverse().join('/')}`,
      })),
    );
    const saida = await PDFDocument.create();
    const recibos = await PDFDocument.load(comprovante);
    const comprovantes = await saida.copyPages(recibos, recibos.getPageIndices());
    if (!eletronicamente) for (const pagina of comprovantes) saida.addPage(pagina);
    const originais = await PDFDocument.load(faces);
    for (const pagina of await saida.copyPages(originais, originais.getPageIndices())) {
      if (!eletronicamente) {
        // A via expedida é uma cópia estática. O scan original fica disponível como download separado.
        pagina.node.delete(PDFName.of('Annots'));
        pagina.node.delete(PDFName.of('AA'));
      }
      saida.addPage(pagina);
    }
    if (eletronicamente) for (const pagina of comprovantes) saida.addPage(pagina);
    const final = Buffer.from(await saida.save());
    return { faces, final };
  }

  private async concluir(e: Expedicao, lease: string, pdf: Awaited<ReturnType<ExpedicaoWorkerService['preparar']>>) {
    await this.base.prisma.$transaction(
      async (tx) => {
        const [trabalho] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM expedicao_documento WHERE id = ${e.id} AND estado = 'PROCESSANDO'
          AND reserva_id = ${lease} AND reserva_ate > NOW() FOR UPDATE`;
        if (!trabalho) return;
        const d = e.versao.documento;
        const operador = await tx.usuarios.findFirstOrThrow({ where: { id: e.operador_id, igreja_id: e.igreja_id }, select: { perfil: true } });
        const ator = { igreja_id: e.igreja_id, sub: e.operador_id, perfil: operador.perfil };
        const arquivo = await this.arquivos.storage.saveArtifact(tx, ator, e.id, pdf.final, LIMITE_ARTEFATO_EXPEDICAO);
        await this.arquivos.storage.readVerified(arquivo);
        let faces: Expedicao['arquivo_livro'] = null;
        if (e.versao.livro_id) {
          faces =
            e.conferencia?.arquivo ??
            (await this.arquivos.storage.saveArtifact(
              tx,
              ator,
              e.chave_arquivo_livro,
              pdf.faces,
              LIMITE_ARTEFATO_EXPEDICAO,
            ));
        }
        const agora = new Date();
        const manifesto = {
          formato: 1,
          documento_id: d.id,
          versao_id: e.versao_id,
          modalidade: e.modalidade,
          codigo: e.codigo_verificacao,
          expedido_em: agora.toISOString(),
          fuso_iana: e.fuso_iana,
          aceite: { sha256: e.aceite_sha256, manifesto: e.manifesto_aceite },
          arquivo_final: metadados(arquivo),
          via_coleta: e.via && metadados(e.via),
          scan: e.conferencia && metadados(e.conferencia.arquivo),
          faces_livro: faces && metadados(faces),
          conferencia: e.conferencia && {
            operador_id: e.conferencia.operador_id,
            operador: e.conferencia.operador_nome,
            em: e.conferencia.conferida_em.toISOString(),
            evidencia: e.conferencia.evidencia,
          },
          assinaturas: e.assinaturas.map((a) => ({
            id: a.id,
            arrolado_id: a.arrolado_id,
            pessoa_id: a.arrolado.pessoa_id,
            papeis: a.arrolado.papeis,
            nome: nomeSignatario(a.arrolado),
            metodo: a.metodo,
            registrada_em: a.registrada_em.toISOString(),
          })),
        };
        await tx.expedicao_documento.update({
          where: { id: e.id },
          data: {
            estado: 'CONCLUIDA',
            arquivo_final_id: arquivo.id,
            arquivo_livro_id: faces?.id,
            manifesto_final: json(manifesto),
            final_sha256: hashAto(manifesto),
            expedido_em: agora,
            reserva_id: null,
            reserva_ate: null,
          },
        });
        const atualizado = await tx.documento.updateMany({
          where: { id: d.id, igreja_id: e.igreja_id, estado: 'APROVADO', versao_atual: e.versao.numero },
          data: { estado: 'EXPEDIDO', revisao: { increment: 1 } },
        });
        if (atualizado.count !== 1) throw new Error('Versão aprovada indisponível.');
        if (faces) await this.livros.efetivarExpedicao(tx, ator, e.versao_id, faces.id);
        await tx.logs_atividades.create({
          data: {
            igreja_id: e.igreja_id,
            usuario_id: e.operador_id,
            acao: 'ATUALIZACAO',
            tabela_afetada: 'expedicao_documento',
            registro_id: e.id,
            dados_novos: { documento_id: d.id, versao_id: e.versao_id, executor: 'WORKER' },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 },
    );
  }

  async executarUm() {
    if (!assinaturasDisponiveis()) return false;
    const lease = randomUUID();
    const e = await this.reservar(lease);
    if (!e) return false;
    try {
      await this.concluir(e, lease, await this.preparar(e));
    } catch {
      await this.base.prisma.expedicao_documento.updateMany({
        where: { id: e.id, estado: 'PROCESSANDO', reserva_id: lease },
        data: {
          estado: e.tentativas >= limite ? 'FALHOU' : 'PENDENTE',
          reserva_ate: null,
          reserva_id: null,
          executar_apos: new Date(Date.now() + 15_000 * 2 ** (e.tentativas - 1)),
        },
      });
      process.stderr.write('Falha no processamento de uma expedição documental.\n');
    }
    return true;
  }

  async verificar(codigo: string) {
    if (!featureEnabled('secretaria') || !/^[a-f0-9]{32}$/.test(codigo))
      throw new NotFoundException('Código não localizado.');
    const e = await this.base.prisma.expedicao_documento.findUnique({
      where: { codigo_verificacao: codigo },
      include: { arquivo_final: true, versao: { select: { documento: { select: { estado: true } } } } },
    });
    if (
      !e?.expedido_em ||
      e.estado !== 'CONCLUIDA' ||
      !e.arquivo_final ||
      !e.manifesto_final ||
      !['EXPEDIDO', 'ANULADO'].includes(e.versao.documento.estado)
    )
      throw new NotFoundException('Código não localizado.');
    const manifesto = e.manifesto_final as Prisma.JsonObject;
    const final = manifesto.arquivo_final as { id: string; sha256: string; tamanho: number };
    if (
      hashAto(manifesto) !== e.final_sha256 ||
      final?.id !== e.arquivo_final.id ||
      final.sha256 !== e.arquivo_final.sha256 ||
      final.tamanho !== e.arquivo_final.tamanho
    )
      throw indisponivel();
    await this.arquivos.storage.readVerified(e.arquivo_final).catch(() => {
      throw indisponivel();
    });
    return {
      estado: e.versao.documento.estado,
      modalidade: e.modalidade,
      expedido_em: e.expedido_em,
      sha256: e.arquivo_final.sha256,
    };
  }
}
