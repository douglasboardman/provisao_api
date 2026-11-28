import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
import { NotificacoesMandatoService } from '../src/oficiais/notificacoes-mandato.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', admin = 'e1000000-0000-4000-8000-000000000001';
integration('E02: notificações HTTP', () => {
  let app: INestApplication, adminCookie = '', secretarioCookie = '', inscricao = '';
  const pessoa = randomUUID(), oficial = randomUUID(), mandato = randomUUID(), secretario = randomUUID(), anterior = process.env.FEATURE_GOVERNANCA, inicio = new Date();
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    process.env.FEATURE_GOVERNANCA = 'true';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = mod.createNestApplication(); await app.init();
    const p = app.get(PrismaService), sessao = app.get(SessionService);
    await p.usuarios.create({ data: { id: secretario, igreja_id: igreja, nome_usuario: 'Secretário sintético', email_login: `${secretario}@example.invalid`, senha_hash: 'sem-senha', perfil: 'COMUM', ativo: true } });
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Oficial sintético', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    const hoje = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`), posse = new Date(hoje); posse.setUTCDate(posse.getUTCDate() - 30);
    await p.mandato_oficial.create({ data: { id: mandato, igreja_id: igreja, oficial_id: oficial, data_eleicao: posse, data_posse: posse, termino_previsto: hoje, autoridade: 'Conselho', evidencia: 'Ata', avaliacao_eleicao: {} } });
    const user = await p.usuarios.findUniqueOrThrow({ where: { id: admin } });
    adminCookie = `provisao_session=${await sessao.create(admin, igreja, user.auth_version)}`; secretarioCookie = `provisao_session=${await sessao.create(secretario, igreja, 0)}`;
  });
  afterAll(async () => {
    if (anterior === undefined) delete process.env.FEATURE_GOVERNANCA; else process.env.FEATURE_GOVERNANCA = anterior;
    if (!app) return; const p = app.get(PrismaService);
    await p.alerta_mandato.deleteMany({ where: { mandato_id: mandato } });
    await p.logs_atividades.deleteMany({ where: { OR: [{ registro_id: inscricao }, { tabela_afetada: 'politica_alerta_oficiais', registro_id: igreja, created_at: { gte: inicio } }] } });
    await p.inscricao_alerta_oficial.deleteMany({ where: { usuario_id: secretario } }); await p.execucao_alerta_oficiais.deleteMany({ where: { igreja_id: igreja } }); await p.politica_alerta_oficiais.deleteMany({ where: { igreja_id: igreja } });
    await p.mandato_oficial.deleteMany({ where: { id: mandato } }); await p.oficial.deleteMany({ where: { id: oficial } }); await p.pessoas.deleteMany({ where: { id: pessoa } }); await p.usuarios.deleteMany({ where: { id: secretario } }); await app.close();
  });
  it('admin configura destinatário e somente ele consulta e marca seu alerta', async () => {
    const post = (url: string, cookie: string, data: object) => request(app.getHttpServer()).post(url).set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send(data);
    const policy = { ativo: true, dias_antecedencia: 30, dias_apos_termino: 15, fuso_iana: 'UTC', autoridade: 'Conselho', fundamento: 'Ato sintético' };
    await post('/oficiais/configuracao-alertas', secretarioCookie, policy).expect(403);
    await post('/oficiais/configuracao-alertas', adminCookie, policy).expect(201);
    inscricao = (await post('/oficiais/destinatarios-alertas', adminCookie, { usuario_id: secretario }).expect(201)).body.id;
    await app.get(NotificacoesMandatoService).gerar();
    const lista = await request(app.getHttpServer()).get('/oficiais/notificacoes').set('Cookie', secretarioCookie).expect(200);
    expect(lista.headers['cache-control']).toBe('private, no-store'); expect(lista.body).toHaveLength(1);
    expect((await request(app.getHttpServer()).get('/oficiais/notificacoes').set('Cookie', adminCookie).expect(200)).body).toEqual([]);
    const patch = (cookie: string) => request(app.getHttpServer()).patch(`/oficiais/notificacoes/${lista.body[0].id}/lida`).set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    await patch(adminCookie).expect(404); await patch(secretarioCookie).expect(200);
    expect((await request(app.getHttpServer()).get('/oficiais/notificacoes').set('Cookie', secretarioCookie).expect(200)).body[0].lido_em).not.toBeNull();
  });
});
