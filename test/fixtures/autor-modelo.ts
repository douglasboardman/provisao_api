import type { PrismaClient } from '@prisma/client';

// As suítes de tramitação precisam de operadores que ocupem cargos reais no banco de teste.
export async function habilitarAutorDeTeste(db: PrismaClient, igreja_id: string, usuario: string) {
  const u = await db.usuarios.findFirstOrThrow({ where: { id: usuario, igreja_id } });
  const inicio = new Date('2019-01-01');
  const pessoa = u.pessoa_id ?? (await db.pessoas.create({ data: { igreja_id, nome_completo: 'Autor de teste', sexo: 'MASCULINO', data_nascimento: new Date('1980-01-01') } })).id;
  if (!u.pessoa_id) await db.usuarios.update({ where: { id: usuario }, data: { pessoa_id: pessoa } });
  if (!await db.eventos_membresia.findFirst({ where: { igreja_id, pessoa_id: pessoa } }))
    await db.eventos_membresia.create({ data: { igreja_id, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: inicio } });
  const conselho = await db.orgao_interno.findFirst({ where: { igreja_id, tipo: 'CONSELHO', ativo: true } }) ??
    await db.orgao_interno.create({ data: { igreja_id, tipo: 'CONSELHO', constituicao: 'OFICIAL', nome: 'Conselho', sigla: 'CON', finalidade: 'Conselho de teste', criador_id: usuario, data_criacao: inicio } });
  const cargo = await db.cargo_orgao.create({ data: { igreja_id, orgao_id: conselho.id, codigo: 'TESOUREIRO_' + usuario.slice(0,8).toUpperCase(), funcao: 'TESOUREIRO', nome: 'Tesoureiro de teste', permite_acumulacao: true } });
  await db.ocupacao_cargo.create({ data: { igreja_id, orgao_id: conselho.id, pessoa_id: pessoa, cargo_id: cargo.id, inicio } });
  return cargo.id;
}
