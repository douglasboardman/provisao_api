import assert = require('node:assert/strict');
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { hashAto } from '../src/orgaos/idempotencia';

const sha = (dados: Buffer | string) => createHash('sha256').update(dados).digest('hex');

const objeto = (valor: unknown) => {
  assert(valor && typeof valor === 'object' && !Array.isArray(valor));
  return valor as Record<string, unknown>;
};

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor && typeof valor === 'object') {
    const dados = objeto(valor);
    return Object.fromEntries(
      Object.keys(dados)
        .sort()
        .map((chave) => [chave, ordenar(dados[chave])]),
    );
  }
  return valor;
}

async function verificar(prisma: PrismaClient, raiz: string, evidencia: string) {
  const prova = JSON.parse(await readFile(evidencia, 'utf8')) as {
    livro: string;
    ata: string;
    ataVersao: string;
    abertura: string;
    encerramento: string;
    evento: string;
  };
  const livro = await prisma.livro_atas.findUniqueOrThrow({
    where: { id: prova.livro },
    include: { registros: { orderBy: { ordem: 'asc' }, include: { arquivo: true } } },
  });
  assert.equal(livro.estado, 'ENCERRADO');
  assert.deepEqual(
    livro.registros.map((r) => r.versao_id),
    [prova.abertura, prova.ataVersao, prova.encerramento],
  );
  assert.deepEqual(
    livro.registros.map((r) => r.natureza),
    ['ABERTURA', 'ATA_ORIGINAL', 'ENCERRAMENTO'],
  );
  assert.equal(sha(JSON.stringify(ordenar(livro.manifesto))), livro.manifesto_sha256);
  const manifestoLivro = objeto(livro.manifesto);
  assert(Array.isArray(manifestoLivro.registros));
  assert.equal(manifestoLivro.registros.length, livro.registros.length);
  const referencia = await prisma.referencia_ata_membresia.findFirstOrThrow({
    where: { evento_id: prova.evento, igreja_id: livro.igreja_id },
    orderBy: { sequencia: 'desc' },
  });
  assert.equal(referencia.ata_documento_id, prova.ata);
  assert.equal(referencia.versao_id, prova.ataVersao);

  const metadados = (a: { id: string; tamanho: number; sha256: string }) => ({
    id: a.id,
    tamanho: a.tamanho,
    sha256: a.sha256,
  });
  async function verificarBytes(arquivo: { id: string; tamanho: number; sha256: string }) {
    assert.match(arquivo.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const caminho = join(raiz, arquivo.id);
    assert((await lstat(caminho)).isFile());
    const bytes = await readFile(caminho);
    assert.equal(bytes.length, arquivo.tamanho);
    assert.equal(sha(bytes), arquivo.sha256);
    return bytes;
  }

  let assinaturas = 0;
  for (const [indice, registro] of livro.registros.entries()) {
    const e = await prisma.expedicao_documento.findUniqueOrThrow({
      where: { versao_id: registro.versao_id },
      include: {
        matriz: true,
        arquivo_final: true,
        arquivo_livro: true,
        via: true,
        assinaturas: true,
        conferencia: { include: { arquivo: true } },
        versao: { include: { arrolados: true, documento: true, anexos: { include: { arquivo: true } } } },
      },
    });
    assert.equal(e.igreja_id, livro.igreja_id);
    assert.equal(e.estado, 'CONCLUIDA');
    assert.equal(e.versao.documento.estado, 'EXPEDIDO');
    assert.equal(e.versao.documento.versao_atual, e.versao.numero);
    assert(e.versao.congelado_em && e.matriz && e.arquivo_final && e.arquivo_livro && registro.arquivo);
    const aceito = objeto(e.manifesto_aceite);
    const final = objeto(e.manifesto_final);
    assert.equal(aceito.versao_id, registro.versao_id);
    assert.equal(aceito.modalidade, e.modalidade);
    assert.deepEqual(aceito.matriz, metadados(e.matriz));
    assert.equal(hashAto(aceito), e.aceite_sha256);
    assert.equal(final.documento_id, e.versao.documento_id);
    assert.equal(final.versao_id, registro.versao_id);
    assert.deepEqual(final.aceite, { sha256: e.aceite_sha256, manifesto: aceito });
    assert.deepEqual(final.arquivo_final, metadados(e.arquivo_final));
    assert.deepEqual(final.faces_livro, metadados(e.arquivo_livro));
    assert.equal(hashAto(final), e.final_sha256);
    const obrigatorios = e.versao.arrolados.filter((a) => a.obrigatorio);
    assert(obrigatorios.length && obrigatorios.every((a) => e.assinaturas.some((s) => s.arrolado_id === a.id)));
    for (const assinatura of e.assinaturas) {
      assert.equal(assinatura.metodo, e.modalidade);
      assert.equal(assinatura.manifesto_sha256, e.aceite_sha256);
      if (e.modalidade === 'ELETRONICA') assert.equal(objeto(assinatura.evidencias).matriz_sha256, e.matriz.sha256);
      assinaturas++;
    }
    if (e.modalidade === 'FISICA') {
      assert(e.conferencia && e.via);
      assert.deepEqual(final.scan, metadados(e.conferencia.arquivo));
      assert.deepEqual(final.via_coleta, metadados(e.via));
      await verificarBytes(e.conferencia.arquivo);
      await verificarBytes(e.via);
    }
    await verificarBytes(e.matriz);
    await verificarBytes(e.arquivo_final);
    for (const anexo of e.versao.anexos) await verificarBytes(anexo.arquivo);
    assert.equal(registro.estado, 'EFETIVADO');
    assert.equal(registro.arquivo_id, e.arquivo_livro.id);
    const registroManifesto = manifestoLivro.registros[indice];
    assert.equal(registroManifesto.versao_id, registro.versao_id);
    assert.equal(registroManifesto.arquivo_id, e.arquivo_livro.id);
    assert.equal(registroManifesto.sha256, e.arquivo_livro.sha256);
    const faces = await PDFDocument.load(await verificarBytes(e.arquivo_livro));
    assert.equal(faces.getPageCount(), registro.posicao_fim - registro.posicao_inicio + 1);
  }
  return { registros: livro.registros.length, assinaturas, estado: livro.estado, referenciaAoEvento: true };
}

async function main() {
  const [acervo, prova] = process.argv.slice(2);
  if (
    !acervo ||
    !prova ||
    !isAbsolute(acervo) ||
    !isAbsolute(prova) ||
    !/^postgresql:\/\/provisao_test:provisao_test@127\.0\.0\.1:55439\/e10_restauro_[a-f0-9]{8}\?schema=public$/.test(
      process.env.DATABASE_URL ?? '',
    )
  ) {
    throw new Error('Use o banco descartável restaurado pelo roteiro E10.');
  }
  const prisma = new PrismaClient();
  try {
    process.stdout.write(JSON.stringify(await verificar(prisma, acervo, prova)) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((erro) => {
  process.stderr.write(String(erro) + '\n');
  process.exitCode = 1;
});
