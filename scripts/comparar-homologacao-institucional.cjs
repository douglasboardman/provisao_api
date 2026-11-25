#!/usr/bin/env node
// Compara cópias isoladas em transações somente de leitura. A saída contém contagens, sem dados pessoais.
const { PrismaClient } = require('@prisma/client');

const citar = nome => '"' + nome.replaceAll('"', '""') + '"';
const acrescimosEsperados = new Set(['orgao_interno', 'cargo_orgao', 'contexto_secretaria', 'versao_orgao']);
const acompanhar = [
  'igreja', 'usuarios', 'sessoes', 'solicitacao_acesso', 'orgao_interno', 'cargo_orgao', 'ocupacao_cargo', 'membro_orgao',
  'oficial', 'mandato_oficial', 'vinculo_pastoral', 'versao_orgao', 'contexto_secretaria', 'reuniao', 'competencia_secretaria',
  'documento', 'documento_versao', 'modelo_documento', 'modelo_documento_versao', 'livro_atas', 'registro_livro', 'assinatura_documento',
  'arquivo_privado', 'atribuicao_servico', 'evento_autorizacao', 'liberacao_servico',
];

async function inventario(db) {
  const colunas = await db.$queryRaw`
    SELECT c.table_name AS tabela, array_agg(c.column_name::text ORDER BY c.column_name) AS colunas
    FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    GROUP BY c.table_name
  `;
  return new Map(colunas.map(({ tabela, colunas }) => [tabela, colunas]));
}

async function retrato(db, tabela, colunas) {
  const linhas = await db.$queryRawUnsafe(`
    SELECT encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') AS hash, count(*)::int AS total
    FROM (SELECT ${colunas.map(citar).join(', ')} FROM public.${citar(tabela)}) r GROUP BY 1
  `);
  return new Map(linhas.map(({ hash, total }) => [hash, total]));
}

const total = tabela => [...tabela.values()].reduce((soma, n) => soma + n, 0);
function ausentes(antes, depois) {
  return [...antes].reduce((soma, [hash, quantidade]) => soma + Math.max(0, quantidade - (depois.get(hash) ?? 0)), 0);
}

async function acessos(db, tabelas) {
  const [perfis, [{ pessoas_com_varias_contas }], [{ restricoes_pendentes }]] = await Promise.all([
    db.$queryRaw`SELECT perfil::text, count(*)::int AS total,
      count(*) FILTER (WHERE ativo)::int AS ativas,
      count(*) FILTER (WHERE pessoa_id IS NULL)::int AS sem_pessoa
      FROM usuarios GROUP BY perfil ORDER BY perfil::text`,
    db.$queryRaw`SELECT count(*)::int AS pessoas_com_varias_contas FROM (
      SELECT igreja_id, pessoa_id FROM usuarios WHERE pessoa_id IS NOT NULL GROUP BY igreja_id, pessoa_id HAVING count(*) > 1
    ) agrupadas`,
    db.$queryRaw`SELECT count(*)::int AS restricoes_pendentes FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND NOT convalidated`,
  ]);
  const atuacao = tabelas.get('usuarios').includes('conta_atuacao')
    ? (await db.$queryRaw`SELECT count(*)::int AS total FROM usuarios WHERE ativo AND conta_atuacao`)[0].total : null;
  return { perfis, pessoas_com_varias_contas, contas_de_atuacao: atuacao, restricoes_pendentes };
}

async function comparar(antes, depois, exato) {
  const [origem, destino] = await Promise.all([inventario(antes), inventario(depois)]);
  const tabelas = new Set([...origem.keys(), ...destino.keys()].sort());
  if (!exato) tabelas.delete('_prisma_migrations');
  const problemas = [], contagens = {};
  let preservadas = 0, tabelasConferidas = 0;
  for (const tabela of tabelas) {
    const anterior = origem.get(tabela);
    const atual = destino.get(tabela);
    if (anterior && (!atual || anterior.some(c => !atual.includes(c))) ||
        exato && (!anterior || anterior.length !== atual?.length)) problemas.push(tabela + ' · estrutura');
    if (anterior && !atual) continue;

    // A Assembleia passa a apontar para o órgão canônico, com o mesmo ID de contexto e acervo.
    const colunaIgnorada = !exato && tabela === 'contexto_secretaria' ? 'orgao_id' : null;
    const colunas = (anterior ?? atual).filter(c => c !== colunaIgnorada && atual.includes(c));
    if (!colunas.length) continue;
    const [a, b] = await Promise.all([
      anterior ? retrato(antes, tabela, colunas) : Promise.resolve(new Map()),
      retrato(depois, tabela, colunas),
    ]);
    const perdidas = ausentes(a, b);
    const novas = ausentes(b, a);
    if (perdidas || novas && (exato || !acrescimosEsperados.has(tabela))) problemas.push(tabela + ' · linhas');
    if (acompanhar.includes(tabela) || perdidas || novas) contagens[tabela] = [anterior ? total(a) : null, total(b)];
    preservadas += total(a) - perdidas;
    tabelasConferidas++;
  }

  if (!exato) {
    const [vinculosOriginais, vinculosMigrados] = await Promise.all([
      antes.$queryRaw`SELECT id, orgao_id FROM contexto_secretaria WHERE tipo::text <> 'ASSEMBLEIA_GERAL'`,
      depois.$queryRaw`SELECT id, orgao_id FROM contexto_secretaria WHERE tipo::text <> 'ASSEMBLEIA_GERAL'`,
    ]);
    const porId = new Map(vinculosMigrados.map(v => [v.id, v]));
    if (vinculosOriginais.some(v => porId.get(v.id)?.orgao_id !== v.orgao_id)) problemas.push('contextos existentes de Conselho e Junta');
    const [{ total: assembleiasInvalidas }] = await depois.$queryRaw`SELECT count(*)::int AS total
      FROM contexto_secretaria c LEFT JOIN orgao_interno o ON o.id = c.orgao_id AND o.igreja_id = c.igreja_id
      WHERE c.tipo::text = 'ASSEMBLEIA_GERAL' AND o.tipo::text IS DISTINCT FROM 'ASSEMBLEIA_GERAL'`;
    if (assembleiasInvalidas) problemas.push('vínculo institucional da Assembleia');
  }
  const [acessosAntes, acessosDepois] = await Promise.all([acessos(antes, origem), acessos(depois, destino)]);
  return { tabelas_conferidas: tabelasConferidas, linhas_preservadas: preservadas,
    contagens, acessos_antes: acessosAntes, acessos_depois: acessosDepois, problemas };
}

async function main() {
  const { ANTES_DATABASE_URL, DEPOIS_DATABASE_URL } = process.env;
  const argumentos = process.argv.slice(2);
  if (!ANTES_DATABASE_URL || !DEPOIS_DATABASE_URL || ANTES_DATABASE_URL === DEPOIS_DATABASE_URL ||
      argumentos.length > 1 || argumentos.some(a => a !== '--exato')) throw new Error('Configuração inválida.');
  const origem = new PrismaClient({ datasourceUrl: ANTES_DATABASE_URL });
  const destino = new PrismaClient({ datasourceUrl: DEPOIS_DATABASE_URL });
  const opcoes = { isolationLevel: 'RepeatableRead', timeout: 120_000 };
  try {
    const relatorio = await origem.$transaction(async antes => {
      await antes.$executeRaw`SET TRANSACTION READ ONLY`;
      return destino.$transaction(async depois => {
        await depois.$executeRaw`SET TRANSACTION READ ONLY`;
        return comparar(antes, depois, argumentos.includes('--exato'));
      }, opcoes);
    }, opcoes);
    process.stdout.write(JSON.stringify(relatorio, null, 2) + '\n');
    if (relatorio.problemas.length) process.exitCode = 2;
  } finally { await Promise.all([origem.$disconnect(), destino.$disconnect()]); }
}
main().catch(() => { process.stderr.write('Não foi possível comparar as cópias. Confira os bancos e o esquema.\n'); process.exitCode = 1; });
