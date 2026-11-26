import { BadRequestException } from '@nestjs/common';
import type { documento, livro_atas } from '@prisma/client';
import { numeroPorExtenso } from '../core/numero-por-extenso';
import type { Tx } from './secretaria-base.service';
import type { VersaoInput } from './secretaria.dto';

export function identificacaoDocumento(d: Pick<documento, 'numero' | 'ano' | 'sigla' | 'identificacao_livro'>) {
  return d.identificacao_livro ?? (d.numero ? [String(d.numero).padStart(3, '0'), d.ano, d.sigla].join('/') : 'Sem número reservado');
}

export async function cancelarNumeroAta(tx: Tx, documento_id: string, motivo: string) {
  await tx.reserva_ata_livro.updateMany({ where: { documento_id, cancelada_em: null }, data: { cancelada_em: new Date(), motivo } });
}

export async function numerarAta(tx: Tx, d: documento, v: Pick<VersaoInput, 'confirmar_troca_livro' | 'conteudo'>, livro: livro_atas | undefined,
  contexto: string, livroAnterior?: string | null) {
  if (d.tipo !== 'ATA') return;
  const mesmoLivro = livroAnterior === livro?.id;
  if (d.identificacao_livro && !livro) throw new BadRequestException('Selecione um livro aberto para transferir a ata numerada.');
  if (d.numero !== null && !d.identificacao_livro) {
    if (livro?.id !== (livroAnterior ?? undefined)) throw new BadRequestException('Uma ata com numeração anual já atribuída deve conservar seu livro.');
    return;
  }
  if (!livro || d.identificacao_livro && mesmoLivro) return;
  if (d.identificacao_livro) {
    if (!v.confirmar_troca_livro) throw new BadRequestException('Confirme a transferência da ata e a reserva de um novo número.');
    await cancelarNumeroAta(tx, d.id, 'TRANSFERENCIA');
  }
  // ON CONFLICT serializa a atribuição por volume dentro da transação do comando.
  const [contador] = await tx.$queryRaw<{ ultimo: number }[]>`
    INSERT INTO contador_ata_livro (livro_id, ultimo) VALUES (${livro.id}, 1)
    ON CONFLICT (livro_id) DO UPDATE SET ultimo = contador_ata_livro.ultimo + 1 RETURNING ultimo`;
  const numero = contador.ultimo;
  const identificacao_livro = `Ata nº ${numero} · Livro nº ${livro.numero} · ${contexto} · ${livro.serie}`;
  await tx.reserva_ata_livro.create({ data: { livro_id: livro.id, numero, documento_id: d.id, igreja_id: d.igreja_id, contexto_id: d.contexto_id } });
  await tx.documento.update({ where: { id: d.id }, data: { numero, identificacao_livro } });
  Object.assign(d, { numero, identificacao_livro });
  for (const campo of Object.values(v.conteudo.valores ?? {})) {
    if (campo.origem.tipo !== 'sistema' || campo.multiplo) continue;
    if (campo.origem.chave === 'numero_documento' && campo.tipo === 'numero') campo.valor = numero;
    if (campo.origem.chave === 'numero_documento_por_extenso' && campo.tipo === 'texto') campo.valor = numeroPorExtenso(numero);
  }
}

export function atasPendentesLivro(tx: Tx, livro: livro_atas, incluirRestritas = true) {
  return tx.$queryRaw<{ documento_id: string; numero: number; assunto: string }[]>`
    SELECT d.id AS documento_id, d.numero, v.assunto FROM documento d
    JOIN documento_versao v ON v.documento_id = d.id AND v.numero = d.versao_atual
    WHERE v.livro_id = ${livro.id} AND d.igreja_id = ${livro.igreja_id} AND d.contexto_id = ${livro.contexto_id}
    AND (NOT d.restrito OR ${incluirRestritas}) AND d.tipo = 'ATA' AND d.numero IS NOT NULL AND d.estado IN ('EM_EDICAO', 'APROVADO')
    ORDER BY d.numero, d.id`;
}
