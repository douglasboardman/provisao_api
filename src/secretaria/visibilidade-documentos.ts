import { Prisma } from '@prisma/client';
import { permissoesAtasDaConta } from './sigilo-ata';

export async function contextosDasAtasRestritas(tx: Prisma.TransactionClient, igrejaId: string, usuarioId: string) {
  const permissoes = await permissoesAtasDaConta(tx, igrejaId, usuarioId);
  return [...permissoes].filter(([, permissao]) => permissao.ler).map(([id]) => id);
}

/** Usado com o filtro de igreja e de contexto da consulta. */
export function filtroVisibilidadeDocumentos(restritosLegados: boolean | string[], contextosAtas: string[]): Prisma.documentoWhereInput {
  const outros: Prisma.documentoWhereInput = { tipo: { not: 'ATA' } };
  return { OR: [
    { restrito: false },
    { tipo: 'ATA', contexto_id: { in: contextosAtas } },
    ...(Array.isArray(restritosLegados) ? [{ ...outros, contexto_id: { in: restritosLegados } }] : restritosLegados ? [outros] : []),
  ] };
}

/** Para consultas que usam o alias d para documento. */
export function visibilidadeDocumentosSql(legados: string[], atas: string[]) {
  return Prisma.sql`(NOT d.restrito
    ${atas.length ? Prisma.sql`OR (d.tipo = 'ATA' AND d.contexto_id IN (${Prisma.join(atas)}))` : Prisma.empty}
    ${legados.length ? Prisma.sql`OR (d.tipo <> 'ATA' AND d.contexto_id IN (${Prisma.join(legados)}))` : Prisma.empty})`;
}
