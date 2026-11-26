import { NotFoundException } from '@nestjs/common';
import type { Tx } from './secretaria-base.service';
import { permissoesAtas, permissoesAtasDaConta } from './sigilo-ata';

async function exigirLeituraDosAnexos(
  tx: Tx, igrejaId: string, arquivos: string[],
  permissoes: () => ReturnType<typeof permissoesAtas>,
) {
  if (!arquivos.length) return;
  const vinculos = await tx.anexo_documento.findMany({
    where: {
      igreja_id: igrejaId, arquivo_id: { in: arquivos }, versao: { documento: { tipo: 'ATA', restrito: true } },
      // Uma imagem publicada como parte de um modelo tem circulação própria.
      arquivo: { imagens_modelo: { none: {} } },
    },
    select: { contexto_id: true }, distinct: ['contexto_id'],
  });
  if (!vinculos.length) return;
  const autorizacoes = await permissoes();
  if (vinculos.some(v => !autorizacoes.get(v.contexto_id)?.ler)) throw new NotFoundException('Arquivo indisponível.');
}

export function verificarSigiloDosAnexos(tx: Tx, igrejaId: string, usuarioId: string, arquivos: string[]) {
  return exigirLeituraDosAnexos(tx, igrejaId, arquivos, () => permissoesAtasDaConta(tx, igrejaId, usuarioId));
}

export function verificarSigiloDosAnexosDaPessoa(tx: Tx, igrejaId: string, pessoaId: string, arquivos: string[]) {
  return exigirLeituraDosAnexos(tx, igrejaId, arquivos, () => permissoesAtas(tx, igrejaId, pessoaId));
}

/** A matriz congelada identifica as imagens que foram incorporadas ao PDF, inclusive de versões anteriores. */
export async function verificarImagensDasMatrizes(tx: Tx, igrejaId: string, usuarioId: string, versoes: string[]) {
  if (!versoes.length) return;
  const imagens = await tx.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT arquivo->>'id' AS id
    FROM trabalho_renderizacao t CROSS JOIN LATERAL jsonb_array_elements(t.fonte->'arquivos') arquivo
    WHERE t.igreja_id = ${igrejaId} AND t.finalidade = 'MATRIZ_APROVADA' AND t.versao_id = ANY(${versoes}::text[])`;
  await verificarSigiloDosAnexos(tx, igrejaId, usuarioId, imagens.map(i => i.id));
}
