import { contextosDasAtasRestritas, visibilidadeDocumentosSql } from './visibilidade-documentos';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { SecretariaBaseService, dataCivil, type AtorSecretaria, type Tx } from './secretaria-base.service';
import { consultaAtuacaoSchema, filtrosAtuacaoSchema, resultadosResolucao } from './resolucoes.dto';
import { validar } from './secretaria.dto';

type Filtros = z.infer<typeof filtrosAtuacaoSchema>;
type Resultado = keyof typeof resultadosResolucao;
type Atuacao = {
  versao_id: string;
  documento_id: string;
  contexto_id: string;
  versao: number;
  versao_atual: boolean;
  estado: string;
  contexto: string;
  numero: string;
  data: string;
  assunto: string;
  resolucao_id: string | null;
  ordem: number | null;
  resultado: Resultado | null;
  eficaz: boolean | null;
  proponentes: string | null;
  dissidentes: string | null;
  autoria: boolean;
  coautoria: boolean;
  dissidencia: boolean;
  presenca: boolean;
  assinatura: boolean;
};
const paginaTamanho = 30;
const limiteExportacao = 1000;
const colunasAtuacao = ['autoria', 'coautoria', 'dissidencia', 'presenca', 'assinatura'] as const;

@Injectable()
export class AtuacaoService {
  constructor(private readonly base: SecretariaBaseService) {}

  private async fonte(tx: Tx, ator: AtorSecretaria, f: Filtros) {
    const conta = await this.base.operador(tx, ator);
    if (f.contexto) await this.base.contexto(tx, ator, f.contexto);
    const restritos = (await this.base.concessoes(tx, ator, f.contexto))
      .filter((c) => c.pode_consultar_restritos)
      .map((c) => c.contexto_id);
    const atas = await contextosDasAtasRestritas(tx, ator.igreja_id, ator.sub);
    const pessoa = f.pessoa ?? null;
    const resolucoes = f.tipo === 'resolucoes';
    const assunto = f.assunto ? '%' + f.assunto.replace(/[\\%_]/g, '\\$&') + '%' : null;
    const recorte = [
      Prisma.sql`v.igreja_id = ${ator.igreja_id}`,
      Prisma.sql`v.congelado_em IS NOT NULL`,
      visibilidadeDocumentosSql(restritos, atas),
    ];
    if (f.contexto) recorte.push(Prisma.sql`v.contexto_id = ${f.contexto}`);
    if (conta.perfil === 'COMUM') {
      const contextos = await tx.contexto_secretaria.findMany({ where: { igreja_id: ator.igreja_id }, include: { orgao: true } });
      const visiveis: string[] = [];
      for (const c of contextos) if (await this.base.contextoVisivel(tx, c, conta)) visiveis.push(c.id);
      recorte.push(visiveis.length ? Prisma.sql`v.contexto_id IN (${Prisma.join(visiveis)})` : Prisma.sql`FALSE`);
    }
    if (f.de) recorte.push(Prisma.sql`v.data_documento >= ${dataCivil(f.de)}::date`);
    if (f.ate) recorte.push(Prisma.sql`v.data_documento <= ${dataCivil(f.ate)}::date`);
    if (assunto && !resolucoes) recorte.push(Prisma.sql`v.assunto ILIKE ${assunto}`);
    const filtroResolucoes = [
      f.resultado ? Prisma.sql`r.resultado = ${f.resultado}::resolucao_resultado` : Prisma.sql`TRUE`,
      assunto && resolucoes ? Prisma.sql`r.assunto ILIKE ${assunto}` : Prisma.sql`TRUE`,
    ];

    // Filtra por igreja e sigilo antes de ler pessoas, apurar indicadores ou contar linhas.
    return Prisma.sql`
      WITH versoes AS MATERIALIZED (
        SELECT v.id, d.id AS documento_id, d.contexto_id, v.numero AS versao, (v.numero = d.versao_atual) AS versao_atual,
          d.estado::text AS estado, v.data_documento AS data, v.assunto,
          COALESCE(v.fonte_congelada #>> '{contexto,nome}', c.nome) AS contexto,
          COALESCE(v.fonte_congelada->>'numero', '') AS numero,
          v.fonte_congelada #> '{reuniao,participantes}' AS participantes
        FROM documento_versao v
        JOIN documento d ON d.id = v.documento_id
        JOIN contexto_secretaria c ON c.id = d.contexto_id
        WHERE ${Prisma.join(recorte, ' AND ')}
      ), resolucoes AS (
        SELECT r.id, r.versao_id, r.ordem, r.assunto, r.resultado, r.eficaz,
          p.nomes AS proponentes, diss.nomes AS dissidentes,
          COALESCE(p.atuou, false) AS autoria, (COALESCE(p.atuou, false) AND p.total > 1) AS coautoria,
          COALESCE(diss.atuou, false) AS dissidencia
        FROM versoes v JOIN resolucao r ON r.versao_id = v.id
        CROSS JOIN LATERAL (
          SELECT COUNT(*) AS total, bool_or(${pessoa}::text IS NULL OR a.pessoa_id = ${pessoa}) AS atuou,
            string_agg(${this.nomeArrolado()}, '; ' ORDER BY a.retrato->>'nome', a.pessoa_id) AS nomes
          FROM resolucao_proponente p JOIN arrolado_documento a ON a.id = p.arrolado_id
          WHERE p.resolucao_id = r.id
        ) p
        CROSS JOIN LATERAL (
          SELECT bool_or(${pessoa}::text IS NULL OR a.pessoa_id = ${pessoa}) AS atuou,
            string_agg(${this.nomeArrolado()}, '; ' ORDER BY a.retrato->>'nome', a.pessoa_id) AS nomes
          FROM resolucao_dissidente dd JOIN arrolado_documento a ON a.id = dd.arrolado_id
          WHERE dd.resolucao_id = r.id
        ) diss
        WHERE ${Prisma.join(filtroResolucoes, ' AND ')}
      ), itens AS (
        SELECT v.id AS versao_id, v.documento_id, v.contexto_id, v.versao, v.versao_atual, v.estado,
          v.contexto, v.numero, to_char(v.data, 'YYYY-MM-DD') AS data,
          ${
            resolucoes
              ? Prisma.sql`
            r.assunto, r.id AS resolucao_id, r.ordem, r.resultado, r.eficaz, r.proponentes, r.dissidentes,
            r.autoria, r.coautoria, r.dissidencia
          `
              : Prisma.sql`
            v.assunto, NULL::text AS resolucao_id, NULL::int AS ordem, NULL::resolucao_resultado AS resultado,
            NULL::boolean AS eficaz, NULL::text AS proponentes, NULL::text AS dissidentes,
            COALESCE(r.autoria, false) AS autoria, COALESCE(r.coautoria, false) AS coautoria,
            COALESCE(r.dissidencia, false) AS dissidencia
          `
          },
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(v.participantes, 'null'), '[]')) presenca
            WHERE presenca->'presente' = 'true'::jsonb AND (${pessoa}::text IS NULL OR presenca->>'pessoa_id' = ${pessoa})
          ) AS presenca,
          EXISTS (
            SELECT 1 FROM assinatura_documento s JOIN arrolado_documento a ON a.id = s.arrolado_id
            WHERE s.versao_id = v.id AND (${pessoa}::text IS NULL OR a.pessoa_id = ${pessoa})
          ) AS assinatura
        FROM versoes v
        ${
          resolucoes
            ? Prisma.sql`JOIN resolucoes r ON r.versao_id = v.id`
            : Prisma.sql`
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS total, bool_or(r.autoria) AS autoria, bool_or(r.coautoria) AS coautoria,
              bool_or(r.dissidencia) AS dissidencia
            FROM resolucoes r WHERE r.versao_id = v.id
          ) r ON TRUE
          ${f.resultado ? Prisma.sql`WHERE r.total > 0` : Prisma.empty}
        `
        }
      ), selecionados AS (
        SELECT * FROM itens
        ${pessoa ? Prisma.sql`WHERE autoria OR dissidencia OR presenca OR assinatura` : Prisma.empty}
      )`;
  }

  private nomeArrolado() {
    return Prisma.sql`(a.retrato->>'nome') || COALESCE(
      ' (' || (
        SELECT string_agg(cargo->>'nome', ', ' ORDER BY ordem)
        FROM jsonb_array_elements(COALESCE(a.retrato->'cargos', '[]')) WITH ORDINALITY AS cargos(cargo, ordem)
      ) || ')', ' (' || (a.retrato #>> '{cargo,nome}') || ')', ''
    )`;
  }

  private linhas(tx: Tx, fonte: Prisma.Sql, offset: number, limite: number) {
    return tx.$queryRaw<Atuacao[]>`${fonte}
      SELECT * FROM selecionados ORDER BY data DESC, documento_id, versao DESC, ordem
      LIMIT ${limite} OFFSET ${offset}`;
  }

  consultar(ator: AtorSecretaria, entrada: unknown) {
    const { pagina, ...filtros } = validar(consultaAtuacaoSchema, entrada);
    return this.base.prisma.$transaction(
      async (tx) => {
        const fonte = await this.fonte(tx, ator, filtros);
        const [totais] = await tx.$queryRaw<
          (Record<(typeof colunasAtuacao)[number], number> & { total: number })[]
        >`${fonte}
        SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE autoria)::int AS autoria,
          COUNT(*) FILTER (WHERE coautoria)::int AS coautoria, COUNT(*) FILTER (WHERE dissidencia)::int AS dissidencia,
          COUNT(*) FILTER (WHERE presenca)::int AS presenca, COUNT(*) FILTER (WHERE assinatura)::int AS assinatura
        FROM selecionados`;
        const itens = await this.linhas(tx, fonte, pagina * paginaTamanho, paginaTamanho);
        return { itens, totais, pagina, tamanho: paginaTamanho };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  exportar(ator: AtorSecretaria, entrada: unknown) {
    const filtros = validar(filtrosAtuacaoSchema, entrada);
    return this.base.prisma.$transaction(
      async (tx) => {
        const fonte = await this.fonte(tx, ator, filtros);
        const itens = await this.linhas(tx, fonte, 0, limiteExportacao + 1);
        if (itens.length > limiteExportacao)
          throw new BadRequestException('Refine os filtros para exportar até 1.000 registros.');
        await tx.logs_atividades.create({
          data: { igreja_id: ator.igreja_id, usuario_id: ator.sub, acao: 'CONSULTA', tabela_afetada: 'secretaria' },
        });
        return csvAtuacao(itens, filtros.tipo);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

function csvAtuacao(itens: Atuacao[], tipo: Filtros['tipo']) {
  const resolucoes = tipo === 'resolucoes';
  const celula = (texto: string | number) => {
    const valor = String(texto);
    const seguro = /^[\s\uFEFF]*[=+\-@]/u.test(valor) || /^[\t\r\n]/.test(valor) ? "'" + valor : valor;
    return '"' + seguro.replaceAll('"', '""') + '"';
  };
  const simNao = (v: boolean) => (v ? 'Sim' : 'Não');
  const cabecalho = [
    'Documento',
    'Versão',
    'Versão atual',
    'Estado do documento',
    'Contexto',
    'Data',
    'Assunto',
    ...(resolucoes ? ['Ordem', 'Resultado', 'Eficácia registrada', 'Proponentes', 'Dissidentes'] : []),
    'Autoria',
    'Coautoria',
    'Dissidência',
    'Presença na reunião',
    'Assinatura registrada',
  ];
  const linhas = itens.map((r) => [
    r.numero,
    r.versao,
    simNao(r.versao_atual),
    r.estado,
    r.contexto,
    r.data,
    r.assunto,
    ...(resolucoes
      ? [
          r.ordem ?? '',
          r.resultado ? resultadosResolucao[r.resultado] : '',
          simNao(!!r.eficaz),
          r.proponentes ?? 'Sem proponente informado',
          r.dissidentes ?? '',
        ]
      : []),
    ...colunasAtuacao.map((c) => simNao(r[c])),
  ]);
  return '\uFEFF' + [cabecalho, ...linhas].map((l) => l.map(celula).join(';')).join('\r\n') + '\r\n';
}
