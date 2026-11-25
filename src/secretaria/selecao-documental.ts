import { Prisma } from '@prisma/client';
import { buscaAta } from './referencias-ata.dto';
import { validar } from './secretaria.dto';
import type { Tx } from './secretaria-base.service';

export const tabelasDocumentais = Prisma.sql`
  FROM documento_versao v
  JOIN documento d ON d.id = v.documento_id AND d.igreja_id = v.igreja_id
  JOIN contexto_secretaria c ON c.id = d.contexto_id AND c.igreja_id = d.igreja_id`;

const numeroFormatado = Prisma.sql`coalesce(v.numero_original, v.fonte_congelada->>'numero', d.identificacao_livro,
    CASE WHEN d.numero IS NOT NULL THEN concat_ws('/', lpad(d.numero::text, greatest(3, length(d.numero::text)), '0'), d.ano, d.sigla) END)`;

export function buscaNumero(termo: string) {
  const [numero, ano, sigla] = termo.match(/^(\d{1,10})(?:\/(\d{4})(?:\/([^/]{1,40}))?)?$/)?.slice(1) ?? [];
  const numeroPadrao = numero
    ? Prisma.sql`OR (d.numero = ${Number(numero)}::bigint
    ${ano ? Prisma.sql`AND d.ano = ${Number(ano)}` : Prisma.empty}
    ${sigla ? Prisma.sql`AND lower(d.sigla) = lower(${sigla})` : Prisma.empty})`
    : Prisma.empty;
  const numeroOriginal =
    numero && !ano
      ? Prisma.sql`OR (v.numero_original ~ '^[0-9]+$' AND ltrim(v.numero_original, '0') = ${numero.replace(/^0+/, '')})`
      : Prisma.empty;
  return Prisma.sql`(lower(${numeroFormatado}) = lower(${termo}) ${numeroPadrao} ${numeroOriginal})`;
}

// O chamador fornece o escopo já autorizado, com os aliases v, d e c.
export async function selecionarDocumentos(tx: Tx, escopo: Prisma.Sql, parametros: unknown, convocatorias = false) {
  const f = validar(buscaAta, parametros);
  const pauta = Prisma.sql`coalesce(v.fonte_congelada #>> '{legado,reuniao,pauta}',
    v.fonte_congelada #>> '{reuniao,dados,pauta}', (SELECT r.dados->>'pauta' FROM reuniao r
      WHERE r.id = v.reuniao_id AND r.igreja_id = v.igreja_id AND (NOT r.restrito OR d.restrito)), '')`;
  const reconvocacao = convocatorias ? Prisma.sql`EXISTS (
    SELECT 1 FROM documento_versao anterior JOIN documento ed ON ed.id = anterior.documento_id
    JOIN modelo_documento_versao modelo ON modelo.id = anterior.modelo_versao_id
    JOIN expedicao_documento emitida ON emitida.versao_id = anterior.id
    WHERE anterior.reuniao_id = v.reuniao_id AND ed.igreja_id = d.igreja_id AND ed.contexto_id = d.contexto_id
    AND (NOT ed.restrito OR d.restrito) AND modelo.finalidade = 'CONVOCACAO' AND emitida.estado = 'CONCLUIDA'
    AND emitida.expedido_em < (SELECT expedido_em FROM expedicao_documento WHERE versao_id = v.id))` : Prisma.sql`false`;
  const tamanho = 30;
  const itens = await tx.$queryRaw<unknown[]>`
    SELECT d.id AS documento_id, v.id AS versao_id, v.numero AS versao, ${reconvocacao} AS reconvocacao, v.assunto, d.numero, d.ano, d.sigla,
      d.estado, v.data_documento AS data, c.nome AS contexto, c.id AS contexto_id, ${numeroFormatado} AS numero_formatado,
      ${pauta} AS pauta, ARRAY(SELECT a.retrato->>'nome' FROM arrolado_documento a WHERE a.versao_id = v.id ORDER BY 1, a.id) AS arrolados,
      coalesce((SELECT jsonb_agg(jsonb_build_object('assunto', r.assunto, 'texto', r.texto_deliberado, 'resultado', r.resultado)
        ORDER BY r.ordem) FROM resolucao r WHERE r.versao_id = v.id), '[]'::jsonb) AS resolucoes
    ${escopo}
    ${f.contexto ? Prisma.sql`AND c.id = ${f.contexto}` : Prisma.empty}
    ${f.assunto ? Prisma.sql`AND strpos(lower(v.assunto), lower(${f.assunto})) > 0` : Prisma.empty}
    ${f.numero ? Prisma.sql`AND ${buscaNumero(f.numero)}` : Prisma.empty}
    ${f.data ? Prisma.sql`AND v.data_documento = ${f.data}::date` : Prisma.empty}
    ${f.de ? Prisma.sql`AND v.data_documento >= ${f.de}::date` : Prisma.empty}
    ${f.ate ? Prisma.sql`AND v.data_documento <= ${f.ate}::date` : Prisma.empty}
    ${f.pauta ? Prisma.sql`AND strpos(lower(${pauta}), lower(${f.pauta})) > 0` : Prisma.empty}
    ${
      f.arrolado
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM arrolado_documento a WHERE a.versao_id = v.id
      AND strpos(lower(a.retrato->>'nome'), lower(${f.arrolado})) > 0)`
        : Prisma.empty
    }
    ORDER BY v.data_documento DESC, d.id, v.numero DESC LIMIT ${tamanho + 1} OFFSET ${f.pagina * tamanho}`;
  const contextos = await tx.$queryRaw`SELECT DISTINCT c.id, c.nome, c.sigla ${escopo} ORDER BY c.nome, c.id`;
  return { itens: itens.slice(0, tamanho), tem_proxima: itens.length > tamanho, contextos };
}
