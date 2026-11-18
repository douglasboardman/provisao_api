import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igrejaA = 'e0000000-0000-4000-8000-000000000001', igrejaB = 'e0000000-0000-4000-8000-000000000002';
const adminA = 'e1000000-0000-4000-8000-000000000001', adminB = 'e1000000-0000-4000-8000-000000000002';
integration('E02: consultas HTTP protegidas', () => {
  let app: INestApplication, cookieA: string, cookieB: string, cookieAuditor: string;
  const pessoaId = randomUUID(), oficialId = randomUUID(), auditorId = randomUUID();
  let oficialCriado: string | undefined;
  const flagAnterior = process.env.FEATURE_GOVERNANCA;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = modulo.createNestApplication(); await app.init();
    const prisma = app.get(PrismaService);
    await prisma.pessoas.create({ data: { id: pessoaId, igreja_id: igrejaA, nome_completo: 'Pessoa HTTP Sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await prisma.usuarios.create({ data: { id: auditorId, igreja_id: igrejaA, nome_usuario: 'Auditor sintético', email_login: `${auditorId}@example.invalid`, senha_hash: 'nao-utilizavel', perfil: 'AUDITOR', ativo: true } });
    cookieAuditor = `provisao_session=${await app.get(SessionService).create(auditorId, igrejaA, 0)}`;
    await prisma.oficial.create({ data: { id: oficialId, igreja_id: igrejaA, pessoa_id: pessoaId, tipo: 'DIACONO' } });
    for (const [id, igreja, assign] of [[adminA, igrejaA, (s: string) => { cookieA = s; }], [adminB, igrejaB, (s: string) => { cookieB = s; }]] as const) {
      const user = await prisma.usuarios.findUniqueOrThrow({ where: { id } });
      assign(`provisao_session=${await app.get(SessionService).create(id, igreja, user.auth_version)}`);
    }
  });
  afterAll(async () => {
    if (flagAnterior === undefined) delete process.env.FEATURE_GOVERNANCA; else process.env.FEATURE_GOVERNANCA = flagAnterior;
    if (app) { const p = app.get(PrismaService); if (oficialCriado) await p.logs_atividades.deleteMany({ where: { registro_id: oficialCriado } }); await p.oficial.deleteMany({ where: { pessoa_id: pessoaId } }); await p.pessoas.deleteMany({ where: { id: pessoaId } }); await p.usuarios.deleteMany({ where: { id: auditorId } }); await app.close(); }
  });
  it('exige sessão e chave, limita escopo e não divulga motivo disciplinar', async () => {
    delete process.env.FEATURE_GOVERNANCA;
    await request(app.getHttpServer()).get('/oficiais').expect(401);
    await request(app.getHttpServer()).get('/oficiais').set('Cookie', cookieA).expect(404);
    await request(app.getHttpServer()).post('/oficiais').set('Cookie', cookieA).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ pessoa_id: pessoaId, tipo: 'PRESBITERO_REGENTE' }).expect(404);
    process.env.FEATURE_GOVERNANCA = 'true';
    await request(app.getHttpServer()).get('/oficiais').set('Cookie', cookieAuditor).expect(200);
    await request(app.getHttpServer()).get(`/oficiais/${oficialId}/eventos-sensiveis`).set('Cookie', cookieAuditor).expect(403);
    await request(app.getHttpServer()).post('/oficiais').set('Cookie', cookieA).set('Origin', 'http://origem-invalida.invalid').set('X-Provisao-Request', '1').send({ pessoa_id: pessoaId, tipo: 'PRESBITERO_REGENTE' }).expect(403);
    await request(app.getHttpServer()).post('/oficiais').set('Cookie', cookieAuditor).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ pessoa_id: pessoaId, tipo: 'PRESBITERO_REGENTE' }).expect(403);
    await request(app.getHttpServer()).post('/oficiais').set('Cookie', cookieB).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ pessoa_id: pessoaId, tipo: 'PRESBITERO_REGENTE' }).expect(404);
    await request(app.getHttpServer()).post('/oficiais').set('Cookie', cookieA).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ pessoa_id: pessoaId, tipo: 'ERRO' }).expect(400);
    const criacao = await request(app.getHttpServer()).post('/oficiais').set('Cookie', cookieA).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ pessoa_id: pessoaId, tipo: 'PRESBITERO_REGENTE' }).expect(201);
    oficialCriado = criacao.body.id;
    await request(app.getHttpServer()).post('/oficiais').set('Cookie', cookieA).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ pessoa_id: pessoaId, tipo: 'PRESBITERO_REGENTE' }).expect(409);
    const lista = await request(app.getHttpServer()).get('/oficiais').set('Cookie', cookieA).expect(200);
    expect(lista.body.itens.map((x: { id: string }) => x.id)).toContain(oficialId);
    expect(lista.headers['cache-control']).toBe('private, no-store');
    const outra = await request(app.getHttpServer()).get('/oficiais').set('Cookie', cookieB).expect(200);
    expect(outra.body.itens.map((x: { id: string }) => x.id)).not.toContain(oficialId);
    await request(app.getHttpServer()).get(`/oficiais/${oficialId}/exercicio?data=2026-01-01`).set('Cookie', cookieB).expect(404);
    const status = await request(app.getHttpServer()).get(`/oficiais/${oficialId}/exercicio?data=2026-01-01`).set('Cookie', cookieA).expect(200);
    expect(status.body).toEqual({ situacao: 'FORA_DE_EXERCICIO', data_referencia: '2026-01-01', revisao_pendente: false });
  });
});
