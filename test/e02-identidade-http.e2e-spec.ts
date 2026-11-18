import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igrejaA = 'e0000000-0000-4000-8000-000000000001', igrejaB = 'e0000000-0000-4000-8000-000000000002', adminA = 'e1000000-0000-4000-8000-000000000001', adminB = 'e1000000-0000-4000-8000-000000000002';
integration('E02: identidade pastoral HTTP entre igrejas', () => {
  let app: INestApplication, cookieA = '', cookieB = '';
  const pessoaA = randomUUID(), pessoaB = randomUUID(), oficialA = randomUUID(), oficialB = randomUUID(), anterior = process.env.FEATURE_GOVERNANCA;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    process.env.FEATURE_GOVERNANCA = 'true';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = mod.createNestApplication(); await app.init();
    const p = app.get(PrismaService), sessions = app.get(SessionService);
    for (const [id, igreja, pessoa] of [[oficialA, igrejaA, pessoaA], [oficialB, igrejaB, pessoaB]]) {
      await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
      await p.oficial.create({ data: { id, igreja_id: igreja, pessoa_id: pessoa, tipo: 'PRESBITERO_DOCENTE' } });
    }
    const [a, b] = await Promise.all([p.usuarios.findUniqueOrThrow({ where: { id: adminA } }), p.usuarios.findUniqueOrThrow({ where: { id: adminB } })]);
    cookieA = `provisao_session=${await sessions.create(adminA, igrejaA, a.auth_version)}`; cookieB = `provisao_session=${await sessions.create(adminB, igrejaB, b.auth_version)}`;
  });
  afterAll(async () => {
    if (anterior === undefined) delete process.env.FEATURE_GOVERNANCA; else process.env.FEATURE_GOVERNANCA = anterior;
    if (!app) return; const p = app.get(PrismaService);
    const refs = await p.referencia_identidade_pastoral.findMany({ where: { oficial_id: { in: [oficialA, oficialB] } }, select: { id: true, identidade_id: true } });
    const identidades = [...new Set(refs.map(r => r.identidade_id))], convites = await p.convite_identidade_pastoral.findMany({ where: { identidade_id: { in: identidades } }, select: { id: true } });
    await p.logs_atividades.deleteMany({ where: { registro_id: { in: [...refs.map(r => r.id), ...convites.map(c => c.id)] } } });
    await p.convite_identidade_pastoral.deleteMany({ where: { identidade_id: { in: identidades } } }); await p.referencia_identidade_pastoral.deleteMany({ where: { id: { in: refs.map(r => r.id) } } });
    await p.identidade_pastoral.deleteMany({ where: { id: { in: identidades } } }); await p.oficial.deleteMany({ where: { id: { in: [oficialA, oficialB] } } }); await p.pessoas.deleteMany({ where: { id: { in: [pessoaA, pessoaB] } } }); await app.close();
  });
  it('exige contexto correto, não expõe outra pessoa e mantém segredo fora dos logs', async () => {
    const post = (path: string, cookie: string, dados: object) => request(app.getHttpServer()).post(path).set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send(dados);
    const convite = await post(`/oficiais/${oficialA}/identidade-pastoral/convites`, cookieA, { destino_igreja_id: igrejaB, autoridade: 'Conselho A', evidencia: 'Registro A' }).expect(201);
    expect(convite.headers['cache-control']).toBe('private, no-store');
    const codigo: string = convite.body.codigo;
    const recebido = await post(`/oficiais/${oficialB}/identidade-pastoral/receber`, cookieB, { codigo, autoridade: 'Conselho B', evidencia: 'Registro B' }).expect(201);
    expect(JSON.stringify(recebido.body)).not.toContain(pessoaA);
    expect(JSON.stringify(recebido.body)).not.toContain(oficialA);
    await post(`/oficiais/${oficialB}/identidade-pastoral/receber`, cookieB, { codigo, autoridade: 'Conselho B', evidencia: 'Registro B' }).expect(400);
    await request(app.getHttpServer()).get(`/oficiais/${oficialA}/identidade-pastoral`).set('Cookie', cookieB).expect(404);
    const p = app.get(PrismaService);
    const logs = await p.logs_atividades.findMany({ where: { tabela_afetada: { in: ['referencia_identidade_pastoral', 'convite_identidade_pastoral'] } }, select: { dados_novos: true, dados_antigos: true } });
    expect(JSON.stringify(logs)).not.toContain(codigo);
  });
});
