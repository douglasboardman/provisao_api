import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PrivateStorageService } from '../private-storage/private-storage.service';
import { hashAto } from '../orgaos/idempotencia';
import { Tx, json } from './secretaria-base.service';

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export const incluirExpedicao = Prisma.validator<Prisma.expedicao_documentoInclude>()({
  matriz: true,
  via: true,
  arquivo_final: true,
  arquivo_livro: true,
  conferencia: { include: { arquivo: true } },
  assinaturas: { include: { arrolado: true }, orderBy: [{ registrada_em: 'asc' }, { id: 'asc' }] },
  versao: {
    include: {
      documento: true,
      registro_livro: true,
      arrolados: { where: { assina: true }, orderBy: { pessoa_id: 'asc' } },
      anexos: { include: { arquivo: true }, orderBy: { arquivo_id: 'asc' } },
    },
  },
});

export type Expedicao = Prisma.expedicao_documentoGetPayload<{ include: typeof incluirExpedicao }>;

export function atualAprovada(e: Expedicao) {
  return (
    e.versao.congelado_em &&
    e.versao.documento.estado === 'APROVADO' &&
    e.versao.numero === e.versao.documento.versao_atual
  );
}

export function obrigatoriosAtendidos(e: Expedicao) {
  const obrigatorios = e.versao.arrolados.filter((a) => a.obrigatorio);
  const assinados = new Set(
    e.assinaturas
      .filter((a) => a.metodo === e.modalidade && a.manifesto_sha256 === e.aceite_sha256)
      .map((a) => a.arrolado_id),
  );
  return obrigatorios.length > 0 && obrigatorios.every((a) => assinados.has(a.id));
}

export function nomeSignatario(a: { retrato: Prisma.JsonValue }) {
  return (a.retrato as { nome: string }).nome;
}

@Injectable()
export class ExpedicaoArquivos {
  constructor(readonly storage: PrivateStorageService) {}

  private manifesto(e: Expedicao, matriz: { id: string; sha256: string; tamanho: number }) {
    return {
      formato: 1,
      versao_id: e.versao_id,
      modalidade: e.modalidade,
      matriz: { id: matriz.id, sha256: matriz.sha256, tamanho: matriz.tamanho },
      anexos: e.versao.anexos.map((a) => ({
        id: a.arquivo_id,
        nome: a.nome,
        tamanho: a.arquivo.tamanho,
        sha256: a.arquivo.sha256,
      })),
    };
  }

  async vincularMatriz(tx: Tx, e: Expedicao) {
    if (e.matriz) return { matriz: e.matriz, hash: e.aceite_sha256! };
    const trabalho = await tx.trabalho_renderizacao.findFirst({
      where: { versao_id: e.versao_id, finalidade: 'MATRIZ_APROVADA', estado: 'CONCLUIDO' },
      include: { arquivo: true },
    });
    if (!trabalho?.arquivo) throw new ConflictException('Aguarde a matriz aprovada ficar disponível.');
    const matriz = trabalho.arquivo;
    const manifesto = this.manifesto(e, matriz);
    await this.storage.readVerified(matriz);
    for (const a of e.versao.anexos) await this.storage.readVerified(a.arquivo);
    const hash = hashAto(manifesto);
    await tx.expedicao_documento.update({
      where: { id: e.id },
      data: { matriz_id: matriz.id, manifesto_aceite: json(manifesto), aceite_sha256: hash },
    });
    return { matriz, hash };
  }

  async verificarAceite(e: Expedicao) {
    if (
      !e.matriz ||
      !e.manifesto_aceite ||
      hashAto(this.manifesto(e, e.matriz)) !== e.aceite_sha256 ||
      hashAto(e.manifesto_aceite as Prisma.JsonObject) !== e.aceite_sha256
    ) {
      throw new ServiceUnavailableException('Integridade do manifesto de aceite inválida.');
    }
    const bytes = await this.storage.readVerified(e.matriz);
    for (const a of e.versao.anexos) await this.storage.readVerified(a.arquivo);
    return bytes;
  }
}

export async function carimbarPdf(bytes: Buffer, legenda: string) {
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const pagina of pdf.getPages()) {
    pagina.drawText(legenda, {
      x: 22,
      y: pagina.getHeight() - 24,
      size: 9,
      font,
      color: rgb(0.16, 0.16, 0.16),
      maxWidth: pagina.getWidth() - 44,
    });
  }
  return Buffer.from(await pdf.save());
}
