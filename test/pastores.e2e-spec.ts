import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';

const integration = process.env.PASTORES_INTEGRATION === '1' ? describe : describe.skip;
integration('Cadastro pastoral integrado', () => {
  let app: INestApplication, db: PrismaService, igreja: string, outra: string, admin: string, comum: string;
  const cookies = new Map<string, string>();
  const http = (user: string, method: 'get' | 'post', path: string) => request(app.getHttpServer())[method](path).set('Cookie', cookies.get(user)!).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  const pessoa = async (church = igreja) => (await db.pessoas.create({ data: { igreja_id: church, nome_completo: 'Pastor de teste', sexo: 'MASCULINO', data_nascimento: new Date('1980-01-01') } })).id;
  const dados = (id: string, funcao = 'AUXILIAR') => ({ pessoa_id: id, funcao, ordenacao: { data: '2000-01-01', responsavel: 'Presbitério', documento: 'Ata de ordenação' }, modalidade: 'Efetivo', concilio: 'Presbitério de teste', ato: 'Designação', inicio: '2026-01-01', evidencia: 'Ata do concílio' });
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável.');
    Object.assign(process.env, { FEATURE_GOVERNANCA: 'true', FEATURE_ORGAOS: 'true', FEATURE_ORGAOS_GESTAO: 'true', FRONTEND_URL: 'http://localhost:3001' });
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(); await app.init(); db = app.get(PrismaService);
    igreja = (await db.igreja.create({ data: { nome: 'Teste pastoral', mfa_obrigatorio: false } })).id;
    outra = (await db.igreja.create({ data: { nome: 'Outra igreja', mfa_obrigatorio: false } })).id;
    for (const perfil of ['ADMINISTRADOR', 'COMUM'] as const) {
      const u = await db.usuarios.create({ data: { igreja_id: igreja, pessoa_id: await pessoa(), perfil, nome_usuario: perfil, email_login: `${randomUUID()}@example.invalid`, senha_hash: 'inutilizavel' } });
      cookies.set(u.id, 'provisao_session=' + await app.get(SessionService).create(u.id, igreja, u.auth_version));
      if (perfil === 'ADMINISTRADOR') admin = u.id; else comum = u.id;
    }
  });
  afterAll(async () => { await app?.close(); });
  it('grava pessoa vinculada, ofício, ordenação e vínculo em conjunto, sem duplicar', async () => {
    const id = await pessoa(); const r = await http(admin, 'post', '/pastores').send(dados(id)).expect(201);
    expect(await db.evento_oficial.count({ where: { oficial_id: r.body.id, tipo: 'ORDENACAO' } })).toBe(1);
    expect(await db.vinculo_pastoral.count({ where: { oficial_id: r.body.id } })).toBe(1);
    await http(admin, 'post', '/pastores').send(dados(id)).expect(409);
    const lista = await http(admin, 'get', '/pastores?data=2026-11-28').expect(200);
    expect(lista.body.find(p => p.id === r.body.id)).toMatchObject({ funcao: 'AUXILIAR', vinculo_na_data: { concilio: 'Presbitério de teste' } });
    expect(await db.logs_atividades.count({ where: { igreja_id: igreja, registro_id: r.body.id, tabela_afetada: 'oficial', acao: 'CRIACAO' } })).toBeGreaterThan(0);
  });
  it('mantém somente um presidente em cadastros concorrentes e desfaz o cadastro recusado', async () => {
    const ids = [await pessoa(), await pessoa()];
    const results = await Promise.all(ids.map(id => http(admin, 'post', '/pastores').send(dados(id, 'PRESIDENTE'))));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await db.presidencia_conselho.count({ where: { igreja_id: igreja } })).toBe(1);
    const falhou = ids[results.findIndex(r => r.status !== 201)];
    expect(await db.oficial.count({ where: { pessoa_id: falhou } })).toBe(0);
    const lista = await http(admin, 'get', '/pastores?data=2026-11-28').expect(200);
    expect(lista.body.filter(p => p.funcao === 'PRESIDENTE')).toHaveLength(1);
  });
  it('isola igrejas e recusa datas inválidas sem registros parciais', async () => {
    await http(admin, 'post', '/pastores').send(dados(await pessoa(outra))).expect(404);
    const id = await pessoa();
    await http(admin, 'post', '/pastores').send({ ...dados(id), inicio: '1990-01-01' }).expect(400);
    expect(await db.oficial.count({ where: { pessoa_id: id } })).toBe(0);
    await http(admin, 'get', '/pastores?data=2026-02-30').expect(400);
  });
  it('exige atribuições de cadastro e de ordenação, preservando o limite da presidência', async () => {
    const id = await pessoa();
    await http(comum, 'post', '/pastores').send(dados(id)).expect(403);
    const u = await db.usuarios.findUniqueOrThrow({ where: { id: comum } });
    for (const acao of ['OFICIAIS_REGISTRAR', 'HISTORICO_OFICIAIS_REGISTRAR']) {
      await db.atribuicao_servico.create({ data: { igreja_id: igreja, usuario_id: comum, pessoa_id: u.pessoa_id!, geracao_vinculo: u.geracao_vinculo, acao, inicio: new Date('2020-01-01') } });
      if (acao === 'OFICIAIS_REGISTRAR') {
        await http(comum, 'post', '/pastores').send(dados(id)).expect(403);
        expect(await db.oficial.count({ where: { pessoa_id: id } })).toBe(0);
      }
    }
    await http(comum, 'post', '/pastores').send(dados(id)).expect(201);
    // Presidente existente encerra antes do período para testar autorização, não conflito.
    await db.presidencia_conselho.updateMany({ where: { igreja_id: igreja }, data: { fim: new Date('2026-06-01') } });
    const novo = await pessoa();
    await http(comum, 'post', '/pastores').send({ ...dados(novo, 'PRESIDENTE'), inicio: '2026-07-01' }).expect(403);
    expect(await db.oficial.count({ where: { pessoa_id: novo } })).toBe(0);
  });
  it('filtra a lista de oficiais pelo tipo antes da paginação', async () => {
    const r = await http(admin, 'get', '/oficiais?tipo=PRESBITERO_DOCENTE').expect(200);
    expect(r.body.itens.length).toBeGreaterThan(0);
    expect(r.body.itens.every(p => p.tipo === 'PRESBITERO_DOCENTE')).toBe(true);
    await http(admin, 'get', '/oficiais?tipo=INVALIDO').expect(400);
  });
});
