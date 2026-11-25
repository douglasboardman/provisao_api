import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { generateSync } from 'otplib';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsuariosService } from '../src/usuarios/usuarios.service';
import { AuthService } from '../src/auth/auth.service';
import { EmailService } from '../src/email/email.service';
import { SessionService } from '../src/auth/session.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { MfaService } from '../src/mfa/mfa.service';
import { EmergencyRecoveryService, emergencyMessage } from '../src/mfa/emergency-recovery.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;

integration('isolamento de usuários entre igrejas (fixture local)', () => {
  let app: INestApplication;
  let token: string;
  beforeAll(async () => {
    // Evita rodar acidentalmente em banco apontado por .env ou CI externa.
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') {
      throw new Error('Este teste exige o banco descartável de test-support/setup.sh');
    }
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    await app.get(PrismaService).usuarios.upsert({ where: { id: 'e1000000-0000-4000-8000-000000000003' }, create: { id: 'e1000000-0000-4000-8000-000000000003', igreja_id: 'e0000000-0000-4000-8000-000000000001', nome_usuario: 'Admin auxiliar teste', email_login: 'auxiliar@example.invalid', senha_hash: 'inutilizavel', perfil: 'ADMINISTRADOR', ativo: true }, update: { ativo: true, perfil: 'ADMINISTRADOR' } });
    const user = await app.get(PrismaService).usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    token = await app.get(SessionService).create(user.id, user.igreja_id, user.auth_version);
  });
  afterAll(async () => { if (app) { await app.get(PrismaService).usuarios.deleteMany({ where: { id: 'e1000000-0000-4000-8000-000000000003' } }); await app.close(); } });
  it('lista apenas usuários da igreja autenticada e rejeita ID de outra igreja', async () => {
    const list = await request(app.getHttpServer()).get('/usuarios').set('Cookie', `provisao_session=${token}`).expect(200);
    expect(list.body.map((user: { id: string }) => user.id)).toContain('e1000000-0000-4000-8000-000000000001');
    expect(list.body.map((user: { id: string }) => user.id)).not.toContain('e1000000-0000-4000-8000-000000000002');
    await request(app.getHttpServer()).get('/usuarios/e1000000-0000-4000-8000-000000000002').set('Cookie', `provisao_session=${token}`).expect(404);
  });
  it('mantém o catálogo de profissões por igreja e permite vincular e desvincular uma pessoa', async () => {
    const prisma = app.get(PrismaService);
    const outraIgreja = 'e0000000-0000-4000-8000-000000000002';
    const sufixo = randomUUID();
    const nome = `Técnica de som ${sufixo}`;
    const outra = await prisma.profissoes.create({ data: { igreja_id: outraIgreja, nome } });
    const http = (metodo: 'get' | 'post' | 'patch' | 'delete', rota: string) => request(app.getHttpServer())[metodo](rota)
      .set('Cookie', `provisao_session=${token}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    let profissaoId: string | undefined;
    let pessoaId: string | undefined;
    try {
      const criada = await http('post', '/profissoes').send({ nome: `  Técnica  de som ${sufixo} ` }).expect(201);
      profissaoId = criada.body.id;
      expect(criada.body.nome).toBe(nome);
      await http('post', '/profissoes').send({ nome: `técnica de som ${sufixo}` }).expect(409);
      const lista = await http('get', '/profissoes').expect(200);
      expect(lista.body.map((p: { id: string }) => p.id)).toContain(profissaoId);
      expect(lista.body.map((p: { id: string }) => p.id)).not.toContain(outra.id);
      expect(lista.body).toEqual(expect.arrayContaining([expect.objectContaining({ nome: 'Do lar' })]));
      await http('patch', `/profissoes/${outra.id}`).send({ nome: 'Outro nome' }).expect(404);

      const pessoa = { nome_completo: 'Pessoa sintética', sexo: 'FEMININO', data_nascimento: '1990-01-01' };
      await http('post', '/pessoas').send({ ...pessoa, profissao_id: outra.id }).expect(400);
      const cadastro = await http('post', '/pessoas').send({ ...pessoa, profissao_id: profissaoId }).expect(201);
      pessoaId = cadastro.body.id;
      expect(cadastro.body.profissao_id).toBe(profissaoId);
      await http('patch', `/profissoes/${profissaoId}`).send({ nome: `Técnica de áudio ${sufixo}` }).expect(200);
      await http('delete', `/profissoes/${profissaoId}`).expect(409);
      const atualizado = await http('patch', `/pessoas/${pessoaId}`).send({ nome_completo: 'Pessoa atualizada' }).expect(200);
      expect(atualizado.body.profissao_id).toBe(profissaoId);
      const semProfissao = await http('patch', `/pessoas/${pessoaId}`).send({ profissao_id: null }).expect(200);
      expect(semProfissao.body.profissao_id).toBeNull();
      await http('delete', `/profissoes/${profissaoId}`).expect(200);
    } finally {
      if (pessoaId) await prisma.pessoas.deleteMany({ where: { id: pessoaId } });
      await prisma.profissoes.deleteMany({ where: { id: { in: profissaoId ? [outra.id, profissaoId] : [outra.id] } } });
    }
  });
  it('permite ao secretário editar profissões e parâmetros de membresia da própria igreja', async () => {
    const prisma = app.get(PrismaService);
    const sessoes = app.get(SessionService);
    const igreja = 'e0000000-0000-4000-8000-000000000001';
    const secretarioId = randomUUID();
    const pessoaId = randomUUID();
    const regrasCriadas: string[] = [];
    const regrasUsadas: string[] = [];
    let profissaoId: string | undefined;
    const http = (sessao: string, metodo: 'get' | 'post' | 'patch' | 'put' | 'delete', rota: string) =>
      request(app.getHttpServer())[metodo](rota).set('Cookie', `provisao_session=${sessao}`)
        .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    async function garantirRegra(nome: string, enum_classificado: string, valor_classificado: string) {
      const existente = await prisma.regras_relacao_enum.findUnique({ where: { modulo_nome: { modulo: 'membresia', nome } } });
      if (existente) return existente.id;
      const criada = await prisma.regras_relacao_enum.create({ data: {
        modulo: 'membresia', nome, tipo_regra: 'FILTRO', enum_classificador: 'membresia_tipo_evento', enum_classificado,
        valores: { create: { valor_classificador: 'ADMISSAO', valor_classificado } },
      } });
      regrasCriadas.push(criada.id);
      return criada.id;
    }
    try {
      const secretario = await prisma.usuarios.create({ data: {
        id: secretarioId, igreja_id: igreja, nome_usuario: 'Secretário de teste', email_login: `${secretarioId}@example.invalid`,
        senha_hash: 'inutilizavel', perfil: 'SECRETARIO', ativo: true,
      } });
      const outraConta = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000002' } });
      const sessao = await sessoes.create(secretario.id, igreja, secretario.auth_version);
      const outraSessao = await sessoes.create(outraConta.id, outraConta.igreja_id, outraConta.auth_version);
      const rols = await garantirRegra('Rols de Admissão', 'membresia_rol', 'NAO_COMUNGANTES');
      const motivos = await garantirRegra('Motivações de Admissão', 'membresia_motivacao_evento', 'PROFISSAO_DE_FE');
      regrasUsadas.push(rols, motivos);
      const base = '/regras-relacao-enum';
      const modulo = `${base}/modulo/membresia`;
      const padrao = (await http(outraSessao, 'get', modulo).expect(200)).body;
      await http(sessao, 'get', `${base}/enums`).expect(200);
      await http(sessao, 'put', `${base}/${rols}/valores`).send({ valores: [] }).expect(403);
      await http(sessao, 'put', `${modulo}/${rols}/valores`).send({ valores: [] }).expect(200);
      await http(sessao, 'put', `${modulo}/${motivos}/valores`).send({
        valores: [{ valor_classificador: 'ADMISSAO', valor_classificado: 'PROFISSAO_DE_FE' }],
      }).expect(200);
      expect((await http(sessao, 'get', modulo).expect(200)).body).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: rols, valores: [] }),
      ]));
      await prisma.pessoas.create({ data: {
        id: pessoaId, igreja_id: igreja, nome_completo: 'Pessoa de teste', data_nascimento: new Date('1980-01-01'), sexo: 'MASCULINO',
      } });
      const admissao = { pessoa_id: pessoaId, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: '2024-02-01' };
      const bloqueada = await http(sessao, 'post', '/eventos-membresia').send(admissao).expect(400);
      expect(bloqueada.body.message).toBe('Rol inválido para admissão.');
      await http(sessao, 'put', `${modulo}/${rols}/valores`).send({
        valores: [{ valor_classificador: 'ADMISSAO', valor_classificado: 'COMUNGANTES' }],
      }).expect(200);
      await http(sessao, 'post', '/eventos-membresia').send(admissao).expect(201);
      expect((await http(outraSessao, 'get', modulo).expect(200)).body).toEqual(padrao);

      const profissao = await http(sessao, 'post', '/profissoes').send({ nome: `Profissão ${secretarioId}` }).expect(201);
      profissaoId = profissao.body.id;
      await http(sessao, 'patch', `/profissoes/${profissaoId}`).send({ nome: `Profissão editada ${secretarioId}` }).expect(200);
      await http(sessao, 'delete', `/profissoes/${profissaoId}`).expect(200);
    } finally {
      await prisma.eventos_membresia.deleteMany({ where: { pessoa_id: pessoaId } });
      await prisma.pessoas.deleteMany({ where: { id: pessoaId } });
      if (profissaoId) await prisma.profissoes.deleteMany({ where: { id: profissaoId } });
      await prisma.parametro_membresia_igreja.deleteMany({ where: { igreja_id: igreja, regra_id: { in: regrasUsadas } } });
      await prisma.regras_relacao_enum.deleteMany({ where: { id: { in: regrasCriadas } } });
      await prisma.logs_atividades.deleteMany({ where: { usuario_id: secretarioId } });
      await prisma.usuarios.deleteMany({ where: { id: secretarioId } });
    }
  });
  it('identifica o mesmo e-mail pela igreja selecionada', async () => {
    const prisma = app.get(PrismaService);
    const ids = ['e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002'];
    const original = await prisma.usuarios.findMany({ where: { id: { in: ids } }, select: { id: true, senha_hash: true } });
    try {
      await prisma.usuarios.updateMany({ where: { id: { in: ids } }, data: { senha_hash: await bcrypt.hash('senha-sintetica', 4) } });
      for (const [index, igreja] of ['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002'].entries()) {
        const result = await request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ login: 'COMPARTILHADO@EXAMPLE.INVALID', senha: 'senha-sintetica', igreja_id: igreja }).expect(200);
        expect(result.body.sub).toBe(ids[index]);
        expect(result.body.igreja_id).toBe(igreja);
        expect(result.headers['set-cookie'][0]).toContain('HttpOnly');
      }
    } finally {
      for (const user of original) await prisma.usuarios.update({ where: { id: user.id }, data: { senha_hash: user.senha_hash } });
    }
  });
  it('revoga acesso enquanto a conta estiver inativa', async () => {
    const prisma = app.get(PrismaService);
    const id = 'e1000000-0000-4000-8000-000000000001';
    try {
      await prisma.usuarios.update({ where: { id }, data: { ativo: false } });
      await request(app.getHttpServer()).get('/usuarios').set('Cookie', `provisao_session=${token}`).expect(401);
    } finally {
      await prisma.usuarios.update({ where: { id }, data: { ativo: true } });
    }
  });
  it('invalida token após alteração de senha', async () => {
    const prisma = app.get(PrismaService);
    const id = 'e1000000-0000-4000-8000-000000000001';
    const igreja = 'e0000000-0000-4000-8000-000000000001';
    const original = await prisma.usuarios.findUniqueOrThrow({ where: { id } });
    const oldToken = await app.get(SessionService).create(id, igreja, original.auth_version);
    try {
      const auth = app.get(AuthService);
      let tokenSenha = '';
      const spy = jest.spyOn(app.get(EmailService), 'sendPasswordReset').mockImplementation(async (_name, _email, url) => { tokenSenha = new URL(url).searchParams.get('token')!; });
      try {
        await auth.forgotPassword(original.email_login, igreja);
        await app.get(OutboxService).runOnce();
        await auth.setPassword(tokenSenha, 'senha-sintetica-nova');
      } finally { spy.mockRestore(); }
      await request(app.getHttpServer()).get('/usuarios').set('Cookie', `provisao_session=${oldToken}`).expect(401);
    } finally {
      await prisma.usuarios.update({ where: { id }, data: { senha_hash: original.senha_hash } });
    }
  });
  it('não restaura token antigo após desativar e reativar a conta', async () => {
    const service = app.get(UsuariosService);
    const id = 'e1000000-0000-4000-8000-000000000001';
    const igreja = 'e0000000-0000-4000-8000-000000000001';
    const original = await app.get(PrismaService).usuarios.findUniqueOrThrow({ where: { id } });
    const oldToken = await app.get(SessionService).create(id, igreja, original.auth_version);
    try {
      await service.update(id, igreja, { ativo: false }, 'e1000000-0000-4000-8000-000000000003');
      await app.get(PrismaService).usuarios.update({ where: { id }, data: { ativo: true, auth_version: { increment: 1 } } });
      await request(app.getHttpServer()).get('/usuarios').set('Cookie', `provisao_session=${oldToken}`).expect(401);
    } finally {
      await app.get(PrismaService).usuarios.update({ where: { id }, data: { ativo: true } });
    }
  });
  it('revoga convite anterior e permite apenas um consumo concorrente', async () => {
    const prisma = app.get(PrismaService);
    const auth = app.get(AuthService);
    const id = 'e1000000-0000-4000-8000-000000000001';
    const igreja = 'e0000000-0000-4000-8000-000000000001';
    const original = await prisma.usuarios.findUniqueOrThrow({ where: { id } });
    const sent: string[] = [];
    const spy = jest.spyOn(app.get(EmailService), 'sendPasswordReset').mockImplementation(async (_name, _email, url) => { sent.push(new URL(url).searchParams.get('token')!); });
    try {
      await auth.forgotPassword(original.email_login, igreja);
      await app.get(OutboxService).runOnce();
      await auth.forgotPassword(original.email_login, igreja);
      await app.get(OutboxService).runOnce();
      expect(sent).toHaveLength(2);
      await expect(auth.setPassword(sent[0], 'senha-sintetica')).rejects.toThrow();
      const results = await Promise.allSettled([auth.setPassword(sent[1], 'senha-sintetica'), auth.setPassword(sent[1], 'senha-sintetica')]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
      await expect(auth.setPassword(sent[1], 'senha-sintetica')).rejects.toThrow();
    } finally {
      spy.mockRestore();
      await prisma.usuarios.update({ where: { id }, data: { senha_hash: original.senha_hash } });
    }
  });
  it('rejeita token expirado e armazena apenas seu hash', async () => {
    const prisma = app.get(PrismaService);
    const auth = app.get(AuthService);
    let token = '';
    const spy = jest.spyOn(app.get(EmailService), 'sendPasswordReset').mockImplementation(async (_name, _email, url) => { token = new URL(url).searchParams.get('token')!; });
    try {
      await auth.forgotPassword('compartilhado@example.invalid', 'e0000000-0000-4000-8000-000000000001');
      await app.get(OutboxService).runOnce();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      const hash = createHash('sha256').update(token).digest('hex');
      expect(await prisma.token_senha.findUnique({ where: { hash: token } })).toBeNull();
      await prisma.token_senha.update({ where: { hash }, data: { expira_em: new Date(0) } });
      await expect(auth.setPassword(token, 'senha-sintetica')).rejects.toThrow();
    } finally { spy.mockRestore(); }
  });
  it('revoga sessões individualmente e rejeita sessão expirada ou de geração antiga', async () => {
    const prisma = app.get(PrismaService);
    const sessions = app.get(SessionService);
    const id = 'e1000000-0000-4000-8000-000000000001';
    const igreja = 'e0000000-0000-4000-8000-000000000001';
    const user = await prisma.usuarios.findUniqueOrThrow({ where: { id } });
    const a = await sessions.create(id, igreja, user.auth_version);
    const b = await sessions.create(id, igreja, user.auth_version);
    const c = await sessions.create(id, igreja, user.auth_version);
    const hashes = [a, b, c].map(value => createHash('sha256').update(value).digest('hex'));
    try {
      expect(await sessions.verify(a)).toEqual(expect.objectContaining({ id, igreja_id: igreja }));
      expect(await prisma.sessoes.findUnique({ where: { token_hash: a } })).toBeNull();
      await sessions.revoke(a);
      await expect(sessions.verify(a)).rejects.toThrow();
      await expect(sessions.verify(b)).resolves.toBeDefined();
      await prisma.sessoes.update({ where: { token_hash: hashes[2] }, data: { expira_em: new Date(0) } });
      await expect(sessions.verify(c)).rejects.toThrow();
      await app.get(UsuariosService).update(id, igreja, { ativo: false }, 'e1000000-0000-4000-8000-000000000003');
      await prisma.usuarios.update({ where: { id }, data: { ativo: true, auth_version: { increment: 1 } } });
      await expect(sessions.verify(b)).rejects.toThrow();
      await expect(sessions.create(id, igreja, user.auth_version)).rejects.toThrow();
    } finally {
      await prisma.sessoes.deleteMany({ where: { token_hash: { in: hashes } } });
      await prisma.usuarios.update({ where: { id }, data: { ativo: true } });
    }
  });
  it('bloqueia CSRF e logout revoga apenas a sessão utilizada', async () => {
    const prisma = app.get(PrismaService);
    const user = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const first = await app.get(SessionService).create(user.id, user.igreja_id, user.auth_version);
    const second = await app.get(SessionService).create(user.id, user.igreja_id, user.auth_version);
    const cookie = `provisao_session=${first}`;
    await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie).set('Origin', 'https://outra.invalid').set('X-Provisao-Request', '1').expect(403);
    await request(app.getHttpServer()).get('/auth/profile').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').expect(204);
    await request(app.getHttpServer()).get('/auth/profile').set('Cookie', cookie).expect(401);
    await request(app.getHttpServer()).get('/auth/profile').set('Cookie', `provisao_session=${second}`).expect(200);
    await app.get(SessionService).revoke(second);
  });
  it('rejeita login de origem não autorizada', async () => {
    await request(app.getHttpServer()).post('/auth/login').set('Origin', 'https://outra.invalid').set('X-Provisao-Request', '1').send({ login: 'compartilhado@example.invalid', senha: 'senha', igreja_id: 'e0000000-0000-4000-8000-000000000001' }).expect(403);
  });
  it('bloqueia senha por terceiro, autoelevação e gestão de contas por gestor', async () => {
    const prisma = app.get(PrismaService);
    const id = 'e1000000-0000-4000-8000-000000000001';
    const user = await prisma.usuarios.findUniqueOrThrow({ where: { id } });
    const session = await app.get(SessionService).create(id, user.igreja_id, user.auth_version);
    const cookie = `provisao_session=${session}`;
    const patch = (body: object) => request(app.getHttpServer()).patch(`/usuarios/${id}`).set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send(body);
    try {
      await patch({ senha: 'senha-de-terceiro' }).expect(400);
      await patch({ perfil: 'OPERADOR' }).expect(403);
      await prisma.usuarios.update({ where: { id }, data: { perfil: 'GESTOR' } });
      await patch({ nome_usuario: 'Não autorizado' }).expect(403);
    } finally {
      await prisma.usuarios.update({ where: { id }, data: { perfil: user.perfil } });
      await app.get(SessionService).revoke(session);
    }
  });
  it('cria conta inativa e impede ativação pelo patch genérico', async () => {
    const prisma = app.get(PrismaService);
    const user = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const session = await app.get(SessionService).create(user.id, user.igreja_id, user.auth_version);
    const cookie = `provisao_session=${session}`;
    const write = (r: request.Test) => r.set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    const payload = { nome_usuario: 'Conta temporária', email_login: 'temporaria@example.invalid', perfil: 'OPERADOR' };
    await write(request(app.getHttpServer()).post('/usuarios')).send({ ...payload, senha: 'senha-de-terceiro', ativo: true }).expect(400);
    const created = await write(request(app.getHttpServer()).post('/usuarios')).send(payload).expect(201);
    try {
      expect(created.body.ativo).toBe(false);
      await write(request(app.getHttpServer()).patch(`/usuarios/${created.body.id}`)).send({ ativo: true }).expect(400);
    } finally {
      await prisma.usuarios.delete({ where: { id: created.body.id } });
      await app.get(SessionService).revoke(session);
    }
  });
  it('vincula duas contas à mesma pessoa com auditoria por conta e isolamento por igreja', async () => {
    const prisma = app.get(PrismaService);
    const actor = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const session = await app.get(SessionService).create(actor.id, actor.igreja_id, actor.auth_version);
    const person = 'e2000000-0000-4000-8000-000000000001';
    const foreign = 'e2000000-0000-4000-8000-000000000002';
    const other = await prisma.usuarios.create({ data: { igreja_id: actor.igreja_id, nome_usuario: 'Temporário', email_login: 'vinculo@example.invalid', senha_hash: 'inutilizavel', perfil: 'OPERADOR', ativo: false } });
    const segunda = await prisma.usuarios.create({ data: { igreja_id: actor.igreja_id, nome_usuario: 'Segunda conta', email_login: 'segunda-conta@example.invalid', senha_hash: 'inutilizavel', perfil: 'COMUM' } });
    const patch = (id: string, pessoa_id: string | null) => request(app.getHttpServer()).patch(`/usuarios/${id}/pessoa`).set('Cookie', `provisao_session=${session}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ pessoa_id });
    try {
      await patch(actor.id, foreign).expect(404);
      await expect(prisma.usuarios.update({ where: { id: actor.id }, data: { pessoa_id: foreign } })).rejects.toThrow();
      await patch(actor.id, person).expect(403);
      await patch(segunda.id, person).expect(200);
      await patch(other.id, person).expect(200);
      expect(await prisma.usuarios.count({ where: { id: { in: [segunda.id, other.id] }, pessoa_id: person } })).toBe(2);
      const audit = await prisma.logs_atividades.findFirst({ where: { igreja_id: actor.igreja_id, usuario_id: actor.id, registro_id: other.id, tabela_afetada: 'usuarios', dados_novos: { path: ['pessoa_id'], equals: person } } });
      expect(audit).toBeTruthy();
      await patch(segunda.id, null).expect(200);
      expect((await prisma.usuarios.findUniqueOrThrow({ where: { id: segunda.id } })).pessoa_id).toBeNull();
      expect((await prisma.usuarios.findUniqueOrThrow({ where: { id: other.id } })).pessoa_id).toBe(person);
    } finally {
      await prisma.usuarios.delete({ where: { id: segunda.id } });
      await prisma.usuarios.delete({ where: { id: other.id } });
      await app.get(SessionService).revoke(session);
    }
  });
  it('protege arquivo privado por usuário e igreja e detecta alteração de bytes', async () => {
    const prisma = app.get(PrismaService);
    const owner = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const outsider = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000002' } });
    const ownSession = await app.get(SessionService).create(owner.id, owner.igreja_id, owner.auth_version);
    const otherSession = await app.get(SessionService).create(outsider.id, outsider.igreja_id, outsider.auth_version);
    const peer = await prisma.usuarios.create({ data: { igreja_id: owner.igreja_id, nome_usuario: 'Outra pessoa', email_login: 'arquivo-peer@example.invalid', senha_hash: 'inutilizavel', perfil: 'ADMINISTRADOR', ativo: true } });
    const peerSession = await app.get(SessionService).create(peer.id, peer.igreja_id, peer.auth_version);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provisao-private-test-'));
    const previous = process.env.PRIVATE_STORAGE_ROOT;
    process.env.PRIVATE_STORAGE_ROOT = dir;
    let id: string | undefined;
    try {
      const upload = await request(app.getHttpServer()).post('/arquivos-privados').set('Cookie', `provisao_session=${ownSession}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').attach('file', Buffer.from('conteúdo sintético'), 'teste.txt').expect(201);
      id = upload.body.id;
      await request(app.getHttpServer()).get(`/arquivos-privados/${id}`).expect(401);
      await request(app.getHttpServer()).get(`/arquivos-privados/${id}`).set('Cookie', `provisao_session=${otherSession}`).expect(404);
      await request(app.getHttpServer()).get(`/arquivos-privados/${id}`).set('Cookie', `provisao_session=${peerSession}`).expect(404);
      await request(app.getHttpServer()).get(`/uploads/${id}`).expect(404);
      const download = await request(app.getHttpServer()).get(`/arquivos-privados/${id}`).set('Cookie', `provisao_session=${ownSession}`).expect(200);
      expect(download.body.toString()).toBe('conteúdo sintético');
      expect(download.headers['cache-control']).toContain('no-store');
      expect(await prisma.logs_atividades.count({ where: { registro_id: id, usuario_id: owner.id, acao: 'DOWNLOAD' } })).toBe(1);
      await fs.writeFile(path.join(dir, id!), 'conteúdo alterado');
      await request(app.getHttpServer()).get(`/arquivos-privados/${id}`).set('Cookie', `provisao_session=${ownSession}`).expect(500);
    } finally {
      if (id) await prisma.arquivo_privado.delete({ where: { id } });
      await fs.rm(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.PRIVATE_STORAGE_ROOT; else process.env.PRIVATE_STORAGE_ROOT = previous;
      await app.get(SessionService).revoke(ownSession);
      await app.get(SessionService).revoke(otherSession);
      await app.get(SessionService).revoke(peerSession);
      await prisma.usuarios.delete({ where: { id: peer.id } });
    }
  });
  it('preserva aprovação quando SMTP falha e retoma tarefa reservada', async () => {
    const prisma = app.get(PrismaService);
    const actor = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const user = await prisma.usuarios.create({ data: { igreja_id: actor.igreja_id, nome_usuario: 'Fila teste', email_login: 'fila@example.invalid', senha_hash: 'inutilizavel', perfil: 'OPERADOR', ativo: false } });
    const spy = jest.spyOn(app.get(EmailService), 'sendPasswordSetup').mockRejectedValueOnce(new Error('erro smtp sintético')).mockResolvedValue(undefined);
    try {
      await app.get(UsuariosService).activate(user.id, actor.igreja_id, actor.id);
      expect((await prisma.usuarios.findUniqueOrThrow({ where: { id: user.id } })).ativo).toBe(true);
      const token = await prisma.token_senha.findFirstOrThrow({ where: { usuario_id: user.id, finalidade: 'password_setup' } });
      let job = await prisma.outbox_email.findUniqueOrThrow({ where: { token_id: token.id } });
      expect(job.estado).toBe('PENDENTE');
      expect(job.payload).not.toContain(token.hash);
      await app.get(OutboxService).runOnce();
      job = await prisma.outbox_email.findUniqueOrThrow({ where: { id: job.id } });
      expect(job.estado).toBe('PENDENTE');
      expect(job.ultimo_erro).toBe('FALHA_ENVIO_OU_PROCESSAMENTO');
      expect((await prisma.usuarios.findUniqueOrThrow({ where: { id: user.id } })).ativo).toBe(true);
      await prisma.outbox_email.update({ where: { id: job.id }, data: { estado: 'PROCESSANDO', reserva_id: 'worker-interrompido', reserva_ate: new Date(0) } });
      await Promise.all([app.get(OutboxService).runOnce(), app.get(OutboxService).runOnce()]);
      job = await prisma.outbox_email.findUniqueOrThrow({ where: { id: job.id } });
      expect(job.estado).toBe('ENVIADO');
      expect(job.payload).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      const tokens = await prisma.token_senha.findMany({ where: { usuario_id: user.id }, select: { id: true } });
      await prisma.outbox_email.deleteMany({ where: { token_id: { in: tokens.map(t => t.id) } } });
      await prisma.token_senha.deleteMany({ where: { usuario_id: user.id } });
      await prisma.usuarios.delete({ where: { id: user.id } });
    }
  });
  it('reverte aprovação se a fila não puder ser cifrada', async () => {
    const prisma = app.get(PrismaService);
    const actor = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const user = await prisma.usuarios.create({ data: { igreja_id: actor.igreja_id, nome_usuario: 'Chave ausente', email_login: 'sem-chave@example.invalid', senha_hash: 'inutilizavel', perfil: 'OPERADOR', ativo: false } });
    const previous = process.env.EMAIL_OUTBOX_KEY;
    try {
      process.env.EMAIL_OUTBOX_KEY = 'invalida';
      await expect(app.get(UsuariosService).activate(user.id, actor.igreja_id, actor.id)).rejects.toThrow();
      expect((await prisma.usuarios.findUniqueOrThrow({ where: { id: user.id } })).ativo).toBe(false);
      expect(await prisma.token_senha.count({ where: { usuario_id: user.id } })).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.EMAIL_OUTBOX_KEY; else process.env.EMAIL_OUTBOX_KEY = previous;
      await prisma.usuarios.delete({ where: { id: user.id } });
    }
  });
  it('separa solicitação da conta, confirma canal e aprova somente após confirmação', async () => {
    const prisma = app.get(PrismaService);
    const actor = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const other = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000002' } });
    const adminSession = await app.get(SessionService).create(actor.id, actor.igreja_id, actor.auth_version);
    const otherSession = await app.get(SessionService).create(other.id, other.igreja_id, other.auth_version);
    const email = 'pedido-integracao@example.invalid';
    let confirmToken = '';
    let cancellationToken = '';
    let setupToken = '';
    const confirmationSpy = jest.spyOn(app.get(EmailService), 'sendAccessConfirmation').mockImplementation(async (_name, _email, url) => { confirmToken = new URL(url).searchParams.get('token')!; cancellationToken = new URL(url).searchParams.get('cancel_token')!; });
    const setupSpy = jest.spyOn(app.get(EmailService), 'sendPasswordSetup').mockImplementation(async (_name, _email, url) => { setupToken = new URL(url).searchParams.get('token')!; });
    let requestId: string | undefined;
    try {
      await request(app.getHttpServer()).post('/auth/register').send({ igreja_id: actor.igreja_id, nome_usuario: 'Pedido Teste', email_login: email }).expect(201);
      const access = await prisma.solicitacao_acesso.findFirstOrThrow({ where: { igreja_id: actor.igreja_id, email_login: email } });
      requestId = access.id;
      expect(access.estado).toBe('AGUARDA_CONFIRMACAO');
      await request(app.getHttpServer()).post('/auth/register').send({ igreja_id: actor.igreja_id, nome_usuario: 'Outra grafia', email_login: email.toUpperCase() }).expect(201);
      expect(await prisma.confirmacao_acesso.count({ where: { solicitacao_id: access.id } })).toBe(1);
      expect(await prisma.usuarios.findFirst({ where: { igreja_id: actor.igreja_id, email_login: email } })).toBeNull();
      const approve = (session: string) => request(app.getHttpServer()).patch(`/solicitacoes-acesso/${access.id}/aprovar`).set('Cookie', `provisao_session=${session}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
      await approve(adminSession).expect(400);
      const listing = await request(app.getHttpServer()).get('/solicitacoes-acesso?pagina=1').set('Cookie', `provisao_session=${adminSession}`).expect(200);
      expect(listing.body.some((item: { id: string }) => item.id === access.id)).toBe(true);
      await request(app.getHttpServer()).get('/solicitacoes-acesso?pagina=-1').set('Cookie', `provisao_session=${adminSession}`).expect(400);
      await app.get(OutboxService).runOnce();
      expect(confirmToken).toMatch(/^[a-f0-9]{64}$/);
      expect(cancellationToken).toMatch(/^[a-f0-9]{64}$/);
      expect(cancellationToken).not.toBe(confirmToken);
      await request(app.getHttpServer()).get(`/auth/confirm-access?token=${confirmToken}`).expect(404);
      expect((await prisma.solicitacao_acesso.findUniqueOrThrow({ where: { id: access.id } })).estado).toBe('AGUARDA_CONFIRMACAO');
      await request(app.getHttpServer()).post('/auth/confirm-access').send({ token: confirmToken }).expect(200);
      await request(app.getHttpServer()).post('/auth/confirm-access').send({ token: confirmToken }).expect(401);
      await approve(otherSession).expect(404);
      const savedKey = process.env.EMAIL_OUTBOX_KEY;
      try {
        process.env.EMAIL_OUTBOX_KEY = 'inválida';
        await approve(adminSession).expect(500);
        expect((await prisma.solicitacao_acesso.findUniqueOrThrow({ where: { id: access.id } })).estado).toBe('EM_ANALISE');
        expect(await prisma.usuarios.findFirst({ where: { igreja_id: actor.igreja_id, email_login: email } })).toBeNull();
      } finally { if (savedKey === undefined) delete process.env.EMAIL_OUTBOX_KEY; else process.env.EMAIL_OUTBOX_KEY = savedKey; }
      await approve(adminSession).expect(200);
      expect((await prisma.solicitacao_acesso.findUniqueOrThrow({ where: { id: access.id } })).situacao_acesso).toBe('CONVITE_PENDENTE');
      await request(app.getHttpServer()).post('/auth/cancel-access').send({ token: cancellationToken }).expect(401);
      await approve(adminSession).expect(400);
      const user = await prisma.usuarios.findFirstOrThrow({ where: { igreja_id: actor.igreja_id, email_login: email } });
      expect(await bcrypt.compare('senha-sintetica', user.senha_hash)).toBe(false);
      await app.get(OutboxService).runOnce();
      expect(setupToken).toMatch(/^[a-f0-9]{64}$/);
      await request(app.getHttpServer()).post('/auth/set-password').send({ token: setupToken, nova_senha: 'senha-sintetica' }).expect(200);
      expect((await prisma.solicitacao_acesso.findUniqueOrThrow({ where: { id: access.id } })).situacao_acesso).toBe('ATIVADA');
      await request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ igreja_id: actor.igreja_id, login: email, senha: 'senha-sintetica' }).expect(200);
    } finally {
      confirmationSpy.mockRestore(); setupSpy.mockRestore();
      if (requestId) {
        const confirmations = await prisma.confirmacao_acesso.findMany({ where: { solicitacao_id: requestId }, select: { id: true } });
        await prisma.outbox_email.deleteMany({ where: { confirmacao_id: { in: confirmations.map(x => x.id) } } });
        await prisma.confirmacao_acesso.deleteMany({ where: { solicitacao_id: requestId } });
        const user = await prisma.usuarios.findFirst({ where: { igreja_id: actor.igreja_id, email_login: email } });
        if (user) {
          const tokens = await prisma.token_senha.findMany({ where: { usuario_id: user.id }, select: { id: true } });
          await prisma.outbox_email.deleteMany({ where: { token_id: { in: tokens.map(x => x.id) } } });
          await prisma.token_senha.deleteMany({ where: { usuario_id: user.id } });
        }
        await prisma.solicitacao_acesso.delete({ where: { id: requestId } });
        if (user) await prisma.usuarios.delete({ where: { id: user.id } });
      }
      await app.get(SessionService).revoke(adminSession); await app.get(SessionService).revoke(otherSession);
    }
  });
  it('cancela por token separado antes ou depois da confirmação e impede reuso', async () => {
    const prisma = app.get(PrismaService);
    const church = 'e0000000-0000-4000-8000-000000000001';
    const created: string[] = [];
    try {
      for (const confirmed of [false, true]) {
        const raw = randomBytes(32).toString('hex');
        const cancellation = createHmac('sha256', Buffer.from(raw, 'hex')).update('provisao-cancelamento-acesso-v1').digest('hex');
        const access = await prisma.solicitacao_acesso.create({ data: { igreja_id: church, nome_usuario: 'Cancelamento teste', email_login: `cancel-${raw}@example.invalid` } });
        created.push(access.id);
        await prisma.confirmacao_acesso.create({ data: { solicitacao_id: access.id, hash: createHash('sha256').update(raw).digest('hex'), cancelamento_hash: createHash('sha256').update(cancellation).digest('hex'), expira_em: new Date(Date.now() + 60_000) } });
        await request(app.getHttpServer()).post('/auth/cancel-access').send({ token: raw }).expect(401);
        await request(app.getHttpServer()).post('/auth/confirm-access').send({ token: cancellation }).expect(401);
        if (confirmed) await request(app.getHttpServer()).post('/auth/confirm-access').send({ token: raw }).expect(200);
        await request(app.getHttpServer()).post('/auth/cancel-access').send({ token: cancellation }).expect(200);
        expect((await prisma.solicitacao_acesso.findUniqueOrThrow({ where: { id: access.id } })).estado).toBe('CANCELADA');
        await request(app.getHttpServer()).post('/auth/cancel-access').send({ token: cancellation }).expect(401);
        await request(app.getHttpServer()).post('/auth/confirm-access').send({ token: raw }).expect(401);
      }
    } finally {
      await prisma.confirmacao_acesso.deleteMany({ where: { solicitacao_id: { in: created } } });
      await prisma.solicitacao_acesso.deleteMany({ where: { id: { in: created } } });
    }
  });
  it('desativa MFA só no espelho autorizado após segundo fator recente e confirmação de senha', async () => {
    const prisma = app.get(PrismaService);
    const senha = 'senha-sintetica-espelho';
    const conta = await prisma.usuarios.create({ data: {
      igreja_id: 'e0000000-0000-4000-8000-000000000001', perfil: 'ADMINISTRADOR', nome_usuario: 'Teste MFA',
      email_login: `espelho-${randomUUID()}@example.invalid`, senha_hash: await bcrypt.hash(senha, 4),
    } });
    const codigo = randomBytes(12).toString('hex');
    const ambiente = { NODE_ENV: process.env.NODE_ENV, HOST: process.env.HOST, DEV_MFA_OPT_OUT_USER_ID: process.env.DEV_MFA_OPT_OUT_USER_ID };
    const post = (rota: string) => request(app.getHttpServer()).post(rota).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    const login = (mfa_code?: string) => post('/auth/login').send({ igreja_id: conta.igreja_id, login: conta.email_login, senha, mfa_code });
    try {
      await prisma.mfa_credencial.create({ data: { usuario_id: conta.id, estado: 'ATIVO', segredo_cifrado: 'fixture' } });
      await prisma.mfa_recuperacao.create({ data: { usuario_id: conta.id, hash: createHash('sha256').update(codigo).digest('hex') } });
      await login().expect(401);
      const autenticado = await login(codigo).expect(200);
      const cookie = autenticado.headers['set-cookie'][0].split(';')[0];
      const desativar = (password: string) => post('/auth/mfa/desativar-no-espelho').set('Cookie', cookie).send({ senha: password });
      Object.assign(process.env, { NODE_ENV: 'production', HOST: '127.0.0.1', DEV_MFA_OPT_OUT_USER_ID: conta.id });
      await desativar(senha).expect(403);
      process.env.NODE_ENV = 'development';
      process.env.DEV_MFA_OPT_OUT_USER_ID = randomUUID();
      await desativar(senha).expect(403);
      process.env.DEV_MFA_OPT_OUT_USER_ID = conta.id;
      await desativar('incorreta').expect(401);
      await prisma.sessoes.updateMany({ where: { usuario_id: conta.id }, data: { mfa_autenticado_em: new Date(0) } });
      await desativar(senha).expect(403);
      await prisma.sessoes.updateMany({ where: { usuario_id: conta.id }, data: { mfa_autenticado_em: new Date() } });
      await desativar(senha).expect(204);
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', cookie).expect(401);
      await login().expect(200);
      expect(await prisma.mfa_recuperacao.count({ where: { usuario_id: conta.id } })).toBe(0);
      expect(await prisma.logs_atividades.count({ where: { usuario_id: conta.id, tabela_afetada: 'mfa_credencial', dados_novos: { path: ['operacao'], equals: 'desativacao_no_espelho' } } })).toBe(1);
    } finally {
      for (const [key, valor] of Object.entries(ambiente)) {
        if (valor === undefined) delete process.env[key]; else process.env[key] = valor;
      }
      await prisma.usuarios.delete({ where: { id: conta.id } });
    }
  });
  it('ativa MFA com recuperação única, impede replay e limita tentativas', async () => {
    const prisma = app.get(PrismaService);
    const id = 'e1000000-0000-4000-8000-000000000001';
    const user = await prisma.usuarios.findUniqueOrThrow({ where: { id } });
    const password = 'senha-sintetica-mfa';
    await prisma.usuarios.update({ where: { id }, data: { senha_hash: await bcrypt.hash(password, 4) } });
    const session = await app.get(SessionService).create(id, user.igreja_id, user.auth_version);
    const write = (r: request.Test) => r.set('Cookie', `provisao_session=${session}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    let peerId: string | undefined;
    let peerAdminId: string | undefined;
    const oldRecoveryKey = process.env.MFA_RECOVERY_PUBLIC_KEY;
    const login = (mfa_code?: string) => request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ igreja_id: user.igreja_id, login: user.email_login, senha: password, ...(mfa_code ? { mfa_code } : {}) });
    try {
      const setup = await write(request(app.getHttpServer()).post('/auth/mfa/setup')).send({ senha: password }).expect(201);
      const stored = await prisma.mfa_credencial.findUniqueOrThrow({ where: { usuario_id: id } });
      expect(stored.segredo_cifrado).not.toContain(setup.body.secret);
      const otp = generateSync({ secret: setup.body.secret });
      const activated = await write(request(app.getHttpServer()).post('/auth/mfa/activate')).send({ codigo: otp }).expect(201);
      expect(activated.body.recovery_codes).toHaveLength(10);
      const freshVersion = (await prisma.usuarios.findUniqueOrThrow({ where: { id } })).auth_version;
      const duplicateSessionHash = createHash('sha256').update(session).digest('hex');
      await expect(app.get(MfaService).verifyLogin(id, user.igreja_id, freshVersion, activated.body.recovery_codes[9], duplicateSessionHash)).rejects.toThrow();
      const untouchedHash = createHash('sha256').update(activated.body.recovery_codes[9]).digest('hex');
      expect((await prisma.mfa_recuperacao.findUniqueOrThrow({ where: { usuario_id_hash: { usuario_id: id, hash: untouchedHash } } })).consumido_em).toBeNull();
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', `provisao_session=${session}`).expect(401);
      const successCount = await prisma.logs_atividades.count({ where: { usuario_id: id, acao: 'LOGIN_SUCESSO' } });
      const sessionsBefore = await prisma.sessoes.count({ where: { usuario_id: id } });
      const challenge = await login().expect(401);
      expect(challenge.body.code).toBe('MFA_REQUIRED');
      expect(challenge.headers['set-cookie']).toBeUndefined();
      expect(await prisma.sessoes.count({ where: { usuario_id: id } })).toBe(sessionsBefore);
      await login(otp).expect(401);
      expect(await prisma.logs_atividades.count({ where: { usuario_id: id, acao: 'LOGIN_SUCESSO' } })).toBe(successCount);
      const recovery = activated.body.recovery_codes[0];
      const firstAttempt = await login(recovery).expect(200); // resposta simuladamente perdida
      await login(recovery).expect(401); // reserva ainda vigente
      const firstHash = createHash('sha256').update(recovery).digest('hex');
      await prisma.mfa_recuperacao.update({ where: { usuario_id_hash: { usuario_id: id, hash: firstHash } }, data: { reserva_ate: new Date(0) } });
      const retry = await login(recovery).expect(200);
      const firstCookie = firstAttempt.headers['set-cookie'][0].split(';')[0];
      const retryCookie = retry.headers['set-cookie'][0].split(';')[0];
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', firstCookie).expect(401);
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', retryCookie).expect(200);
      await login(recovery).expect(401); // consumo confirmado
      for (let i = 0; i < 4; i++) await login('000000000000000000000000').expect(401);
      await login(activated.body.recovery_codes[1]).expect(401);
      await prisma.mfa_credencial.update({ where: { usuario_id: id }, data: { bloqueado_ate: new Date(0) } });
      const recoveredLogin = await login(activated.body.recovery_codes[1]).expect(200);
      const recoveredCookie = recoveredLogin.headers['set-cookie'][0].split(';')[0];
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', recoveredCookie).expect(200);
      const remainingHash = createHash('sha256').update(activated.body.recovery_codes[2]).digest('hex');
      await prisma.mfa_recuperacao.updateMany({ where: { usuario_id: id, hash: { not: remainingHash } }, data: { consumido_em: new Date() } });
      const renew = await request(app.getHttpServer()).post('/auth/mfa/recovery').set('Cookie', recoveredCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password, codigo: activated.body.recovery_codes[2] }).expect(201);
      expect(renew.body.recovery_codes).toHaveLength(10);
      const oldHash = createHash('sha256').update(activated.body.recovery_codes[2]).digest('hex');
      expect((await prisma.mfa_recuperacao.findUniqueOrThrow({ where: { usuario_id_hash: { usuario_id: id, hash: oldHash } } })).consumido_em).toBeNull();
      await login(activated.body.recovery_codes[2]).expect(401);
      await request(app.getHttpServer()).post('/auth/mfa/recovery').set('Cookie', recoveredCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password }).expect(400);
      const resumed = await request(app.getHttpServer()).post('/auth/mfa/recovery/resume').set('Cookie', recoveredCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password }).expect(201);
      expect(resumed.body.recovery_codes).toEqual(renew.body.recovery_codes);
      const currentUser = await prisma.usuarios.findUniqueOrThrow({ where: { id } });
      const otherSession = await app.get(SessionService).create(id, user.igreja_id, currentUser.auth_version);
      try { await request(app.getHttpServer()).post('/auth/mfa/recovery/resume').set('Cookie', `provisao_session=${otherSession}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password }).expect(404); }
      finally { await app.get(SessionService).revoke(otherSession); }
      await request(app.getHttpServer()).post('/auth/mfa/recovery/confirm').set('Cookie', recoveredCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ codigo: '000000000000000000000000' }).expect(401);
      expect((await prisma.mfa_recuperacao.findUniqueOrThrow({ where: { usuario_id_hash: { usuario_id: id, hash: oldHash } } })).consumido_em).toBeNull();
      await request(app.getHttpServer()).post('/auth/mfa/recovery/confirm').set('Cookie', recoveredCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ codigo: renew.body.recovery_codes[9] }).expect(201);
      expect(await prisma.mfa_recuperacao.findUnique({ where: { usuario_id_hash: { usuario_id: id, hash: oldHash } } })).toBeNull();
      await login(activated.body.recovery_codes[3]).expect(401);
      const soleHash = createHash('sha256').update(renew.body.recovery_codes[0]).digest('hex');
      await prisma.mfa_recuperacao.updateMany({ where: { usuario_id: id, hash: { not: soleHash } }, data: { consumido_em: new Date() } });
      const lastLogin = await login(renew.body.recovery_codes[0]).expect(200);
      expect(lastLogin.body.mfa_recovery_recent).toBe(true);
      const lastCookie = lastLogin.headers['set-cookie'][0].split(';')[0];
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', lastCookie).expect(200);
      expect(await prisma.mfa_recuperacao.count({ where: { usuario_id: id, consumido_em: null } })).toBe(0);
      const rawSession = lastCookie.split('=')[1];
      const sessionHash = createHash('sha256').update(rawSession).digest('hex');
      await prisma.sessoes.update({ where: { token_hash: sessionHash }, data: { mfa_autenticado_em: new Date(Date.now() - 11 * 60_000) } });
      await request(app.getHttpServer()).post('/auth/mfa/recovery').set('Cookie', lastCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password }).expect(401);
      await prisma.sessoes.update({ where: { token_hash: sessionHash }, data: { mfa_autenticado_em: new Date() } });
      const lastBatch = await request(app.getHttpServer()).post('/auth/mfa/recovery').set('Cookie', lastCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password }).expect(201);
      const lastResume = await request(app.getHttpServer()).post('/auth/mfa/recovery/resume').set('Cookie', lastCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password }).expect(201);
      expect(lastResume.body.recovery_codes).toEqual(lastBatch.body.recovery_codes);
      await request(app.getHttpServer()).post('/auth/mfa/recovery/confirm').set('Cookie', lastCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ codigo: lastBatch.body.recovery_codes[9] }).expect(201);
      const profile = await request(app.getHttpServer()).get('/auth/profile').set('Cookie', lastCookie).expect(200);
      expect(profile.body.mfa_recovery_recent).toBe(false);
      const freshLogin = await login(lastBatch.body.recovery_codes[0]).expect(200);
      const adminCookie = freshLogin.headers['set-cookie'][0].split(';')[0];
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', adminCookie).expect(200);
      const nextOtp = generateSync({ secret: setup.body.secret, epoch: Math.floor(Date.now() / 1000) + 30 });
      delete process.env.MFA_RECOVERY_PUBLIC_KEY;
      await prisma.mfa_recuperacao.updateMany({ where: { usuario_id: id }, data: { consumido_em: new Date() } });
      await request(app.getHttpServer()).patch('/auth/mfa/policy').set('Cookie', adminCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password, codigo: nextOtp, obrigatorio: true }).expect(400);
      expect((await prisma.igreja.findUniqueOrThrow({ where: { id: user.igreja_id } })).mfa_obrigatorio).toBe(false);
      await prisma.mfa_recuperacao.updateMany({ where: { usuario_id: id, hash: { not: createHash('sha256').update(lastBatch.body.recovery_codes[0]).digest('hex') } }, data: { consumido_em: null } });
      const noKey = await request(app.getHttpServer()).patch('/auth/mfa/policy').set('Cookie', adminCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password, codigo: nextOtp, obrigatorio: true }).expect(400);
      expect(JSON.stringify(noKey.body)).toContain('chave pública');
      process.env.MFA_RECOVERY_PUBLIC_KEY = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
      await request(app.getHttpServer()).patch('/auth/mfa/policy').set('Cookie', adminCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password, codigo: nextOtp, obrigatorio: true }).expect(200);
      const peer = await prisma.usuarios.create({ data: { igreja_id: user.igreja_id, nome_usuario: 'Gestor MFA', email_login: 'gestor-mfa@example.invalid', senha_hash: await bcrypt.hash(password, 4), perfil: 'GESTOR', ativo: true } });
      peerId = peer.id;
      const peerLogin = await request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ igreja_id: user.igreja_id, login: peer.email_login, senha: password }).expect(200);
      expect(peerLogin.body.mfa_enrollment_required).toBe(false);
      const peerCookie = peerLogin.headers['set-cookie'][0].split(';')[0];
      await request(app.getHttpServer()).get('/pessoas').set('Cookie', peerCookie).expect(200);
      await request(app.getHttpServer()).patch('/auth/mfa/policy').set('Cookie', peerCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password, codigo: nextOtp, obrigatorio: false }).expect(401);
      const peerSetup = await request(app.getHttpServer()).post('/auth/mfa/setup').set('Cookie', peerCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password }).expect(201);
      const peerActivation = await request(app.getHttpServer()).post('/auth/mfa/activate').set('Cookie', peerCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ codigo: generateSync({ secret: peerSetup.body.secret }) }).expect(201);
      const peerSignIn = (mfa_code?: string) => request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ igreja_id: user.igreja_id, login: peer.email_login, senha: password, ...(mfa_code ? { mfa_code } : {}) });
      await peerSignIn().expect(401);
      await peerSignIn(peerActivation.body.recovery_codes[0]).expect(200);
      const peerAdmin = await prisma.usuarios.create({ data: { igreja_id: user.igreja_id, nome_usuario: 'Administrador MFA', email_login: 'admin-mfa@example.invalid', senha_hash: await bcrypt.hash(password, 4), perfil: 'ADMINISTRADOR', ativo: true } });
      peerAdminId = peerAdmin.id;
      const adminLogin = await request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ igreja_id: user.igreja_id, login: peerAdmin.email_login, senha: password }).expect(200);
      expect(adminLogin.body.mfa_enrollment_required).toBe(true);
      const peerAdminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];
      await request(app.getHttpServer()).get('/pessoas').set('Cookie', peerAdminCookie).expect(403);
      await request(app.getHttpServer()).get('/auth/mfa').set('Cookie', peerAdminCookie).expect(200);
    } finally {
      if (oldRecoveryKey === undefined) delete process.env.MFA_RECOVERY_PUBLIC_KEY; else process.env.MFA_RECOVERY_PUBLIC_KEY = oldRecoveryKey;
      await prisma.igreja.update({ where: { id: user.igreja_id }, data: { mfa_obrigatorio: false } });
      if (peerId) await prisma.usuarios.delete({ where: { id: peerId } });
      if (peerAdminId) await prisma.usuarios.delete({ where: { id: peerAdminId } });
      await prisma.mfa_recuperacao_pendente.deleteMany({ where: { usuario_id: id } });
      await prisma.mfa_recuperacao.deleteMany({ where: { usuario_id: id } });
      await prisma.mfa_credencial.deleteMany({ where: { usuario_id: id } });
      await prisma.usuarios.update({ where: { id }, data: { senha_hash: user.senha_hash, auth_version: { increment: 1 } } });
    }
  });
  it('não permite ativar política sem MFA próprio', async () => {
    const user = await app.get(PrismaService).usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const session = await app.get(SessionService).create(user.id, user.igreja_id, user.auth_version);
    try {
      await request(app.getHttpServer()).patch('/auth/mfa/policy').set('Cookie', `provisao_session=${session}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: 'senha-sintetica', codigo: '123456', obrigatorio: true }).expect(401);
    } finally { await app.get(SessionService).revoke(session); }
  });
  it('exige competência institucional auditada para gestor analisar acesso', async () => {
    const prisma = app.get(PrismaService);
    const admin = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const pessoa = 'e2000000-0000-4000-8000-000000000001';
    const manager = await prisma.usuarios.create({ data: { igreja_id: admin.igreja_id, nome_usuario: 'Gestor habilitado', email_login: 'gestor-competente@example.invalid', senha_hash: 'inutilizavel', perfil: 'GESTOR', ativo: true, pessoa_id: pessoa } });
    const adminSession = await app.get(SessionService).create(admin.id, admin.igreja_id, admin.auth_version);
    const managerSession = await app.get(SessionService).create(manager.id, manager.igreja_id, manager.auth_version);
    const adminCookie = `provisao_session=${adminSession}`;
    const managerCookie = `provisao_session=${managerSession}`;
    const write = (r: request.Test, cookie: string) => r.set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    const access = await prisma.solicitacao_acesso.create({ data: { igreja_id: admin.igreja_id, nome_usuario: 'Solicitante gestor', email_login: 'aprovado-gestor@example.invalid', estado: 'EM_ANALISE' } });
    const self = await prisma.solicitacao_acesso.create({ data: { igreja_id: admin.igreja_id, nome_usuario: 'Próprio gestor', email_login: manager.email_login, estado: 'EM_ANALISE' } });
    let authorityId: string | undefined;
    const authorityIds: string[] = [];
    try {
      await request(app.getHttpServer()).get('/solicitacoes-acesso').set('Cookie', managerCookie).expect(403);
      await write(request(app.getHttpServer()).post('/solicitacoes-acesso/competencias'), managerCookie).send({ usuario_id: manager.id, referencia: 'Ata de instituição externa 001/2026' }).expect(403);
      const grant = await write(request(app.getHttpServer()).post('/solicitacoes-acesso/competencias'), adminCookie).send({ usuario_id: manager.id, referencia: 'Ata de instituição externa 001/2026' }).expect(201);
      authorityId = grant.body.id;
      authorityIds.push(authorityId!);
      expect(await prisma.logs_atividades.count({ where: { igreja_id: admin.igreja_id, usuario_id: admin.id, tabela_afetada: 'competencia_acesso', registro_id: authorityId } })).toBeGreaterThan(0);
      await request(app.getHttpServer()).get('/solicitacoes-acesso').set('Cookie', managerCookie).expect(200);
      await write(request(app.getHttpServer()).post('/usuarios'), managerCookie).send({ nome_usuario: 'Tentativa', email_login: 'elevacao@example.invalid', perfil: 'ADMINISTRADOR' }).expect(403);
      await write(request(app.getHttpServer()).patch(`/solicitacoes-acesso/${self.id}/aprovar`), managerCookie).expect(401);
      await write(request(app.getHttpServer()).patch(`/usuarios/${manager.id}/pessoa`), adminCookie).send({ pessoa_id: null }).expect(200);
      expect((await prisma.competencia_acesso.findUniqueOrThrow({ where: { id: authorityId } })).revogado_em).not.toBeNull();
      await request(app.getHttpServer()).get('/solicitacoes-acesso').set('Cookie', managerCookie).expect(403);
      await write(request(app.getHttpServer()).patch(`/usuarios/${manager.id}/pessoa`), adminCookie).send({ pessoa_id: pessoa }).expect(200);
      await request(app.getHttpServer()).get('/solicitacoes-acesso').set('Cookie', managerCookie).expect(403);
      const regrant = await write(request(app.getHttpServer()).post('/solicitacoes-acesso/competencias'), adminCookie).send({ usuario_id: manager.id, referencia: 'Ata institucional revisada 002/2026' }).expect(201);
      authorityId = regrant.body.id; authorityIds.push(authorityId!);
      await write(request(app.getHttpServer()).patch(`/usuarios/${manager.id}`), adminCookie).send({ perfil: 'OPERADOR' }).expect(200);
      await write(request(app.getHttpServer()).patch(`/usuarios/${manager.id}`), adminCookie).send({ perfil: 'GESTOR' }).expect(200);
      await request(app.getHttpServer()).get('/solicitacoes-acesso').set('Cookie', managerCookie).expect(403);
      const finalGrant = await write(request(app.getHttpServer()).post('/solicitacoes-acesso/competencias'), adminCookie).send({ usuario_id: manager.id, referencia: 'Ata institucional revisada 003/2026' }).expect(201);
      authorityId = finalGrant.body.id; authorityIds.push(authorityId!);
      await write(request(app.getHttpServer()).patch(`/solicitacoes-acesso/${access.id}/aprovar`), managerCookie).expect(200);
      const decided = await prisma.solicitacao_acesso.findUniqueOrThrow({ where: { id: access.id } });
      expect(decided.analisado_por).toBe(manager.id);
      expect(decided.estado).toBe('APROVADA');
      await write(request(app.getHttpServer()).patch(`/solicitacoes-acesso/competencias/${authorityId}/revogar`), adminCookie).expect(200);
      await request(app.getHttpServer()).get('/solicitacoes-acesso').set('Cookie', managerCookie).expect(403);
    } finally {
      const approved = await prisma.usuarios.findFirst({ where: { igreja_id: admin.igreja_id, email_login: access.email_login } });
      if (approved) {
        const tokens = await prisma.token_senha.findMany({ where: { usuario_id: approved.id }, select: { id: true } });
        await prisma.outbox_email.deleteMany({ where: { token_id: { in: tokens.map(t => t.id) } } });
        await prisma.token_senha.deleteMany({ where: { usuario_id: approved.id } });
      }
      await prisma.solicitacao_acesso.deleteMany({ where: { id: { in: [access.id, self.id] } } });
      if (approved) await prisma.usuarios.delete({ where: { id: approved.id } });
      if (authorityIds.length) await prisma.competencia_acesso.deleteMany({ where: { id: { in: authorityIds } } });
      await app.get(SessionService).revoke(adminSession); await app.get(SessionService).revoke(managerSession);
      await prisma.usuarios.delete({ where: { id: manager.id } });
    }
  });
  it('serializa exclusões concorrentes sem perder o último administrador', async () => {
    const prisma = app.get(PrismaService);
    const church = await prisma.igreja.create({ data: { nome: 'Igreja sintética concorrência' } });
    const createAdmin = (email: string) => prisma.usuarios.create({ data: { igreja_id: church.id, nome_usuario: 'Admin concorrente', email_login: email, senha_hash: 'inutilizavel', perfil: 'ADMINISTRADOR', ativo: true } });
    const a = await createAdmin('concorrencia-a@example.invalid');
    const b = await createAdmin('concorrencia-b@example.invalid');
    const sa = await app.get(SessionService).create(a.id, church.id, a.auth_version);
    const sb = await app.get(SessionService).create(b.id, church.id, b.auth_version);
    const remove = (token: string, id: string) => request(app.getHttpServer()).delete(`/usuarios/${id}`).set('Cookie', `provisao_session=${token}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    try {
      const results = await Promise.all([remove(sa, b.id), remove(sb, a.id)]);
      expect(results.filter(result => result.status === 200)).toHaveLength(1);
      expect(results.some(result => [401, 403, 404, 409].includes(result.status))).toBe(true);
      expect(await prisma.usuarios.count({ where: { igreja_id: church.id, ativo: true, perfil: 'ADMINISTRADOR' } })).toBe(1);
    } finally {
      await prisma.igreja.delete({ where: { id: church.id } });
    }
  });
  it('impede colisões canônicas por igreja sem bloquear o mesmo e-mail em outra igreja', async () => {
    const prisma = app.get(PrismaService);
    const church = 'e0000000-0000-4000-8000-000000000001';
    await expect(prisma.usuarios.create({ data: { igreja_id: church, nome_usuario: 'Colisão', email_login: '  COMPARTILHADO@EXAMPLE.INVALID  ', senha_hash: 'inutilizavel', perfil: 'OPERADOR', ativo: false } })).rejects.toThrow();
    const actor = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const session = await app.get(SessionService).create(actor.id, church, actor.auth_version);
    try { await request(app.getHttpServer()).post('/usuarios').set('Cookie', `provisao_session=${session}`).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ nome_usuario: 'Colisão', email_login: 'COMPARTILHADO@EXAMPLE.INVALID', perfil: 'OPERADOR' }).expect(409); }
    finally { await app.get(SessionService).revoke(session); }
    const register = await request(app.getHttpServer()).post('/auth/register').send({ igreja_id: church, nome_usuario: 'Pedido duplicado', email_login: 'COMPARTILHADO@EXAMPLE.INVALID' }).expect(201);
    expect(register.body.message).toContain('Se os dados puderem');
    expect(await prisma.solicitacao_acesso.count({ where: { igreja_id: church, email_login: 'COMPARTILHADO@EXAMPLE.INVALID' } })).toBe(0);
    expect(await prisma.usuarios.count({ where: { email_login: 'compartilhado@example.invalid', igreja_id: { in: [church, 'e0000000-0000-4000-8000-000000000002'] } } })).toBe(2);
  });
  it('reconcilia arquivos privados sem alterar bytes nem metadados', async () => {
    const prisma = app.get(PrismaService);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'provisao-reconciliacao-'));
    const ids = Array.from({ length: 3 }, () => randomUUID());
    const owner = 'e1000000-0000-4000-8000-000000000001';
    const church = 'e0000000-0000-4000-8000-000000000001';
    const good = Buffer.from('conteúdo sintético');
    const hash = createHash('sha256').update(good).digest('hex');
    try {
      await prisma.arquivo_privado.createMany({ data: ids.map(id => ({ id, usuario_id: owner, igreja_id: church, tamanho: good.length, sha256: hash })) });
      await fs.writeFile(path.join(directory, ids[0]), good);
      await fs.writeFile(path.join(directory, ids[1]), 'conteúdo adulterado');
      await fs.writeFile(path.join(directory, 'arquivo-orvao'), 'órfão');
      let output = '';
      try { execFileSync(process.execPath, ['scripts/reconciliar-arquivos.cjs'], { env: { ...process.env, PRIVATE_STORAGE_ROOT: directory }, encoding: 'utf8' }); }
      catch (error) { const failure = error as { status: number; stdout: string }; expect(failure.status).toBe(2); output = failure.stdout; }
      const result = JSON.parse(output);
      expect(result.metadados).toBeGreaterThanOrEqual(3);
      expect(result.verificados).toBeGreaterThanOrEqual(1);
      expect(result.divergentes).toBeGreaterThanOrEqual(1);
      expect(result.ausentes).toBeGreaterThanOrEqual(1);
      expect(result.sem_metadados).toBe(1);
      expect(await fs.readFile(path.join(directory, ids[0]))).toEqual(good);
      expect(await prisma.arquivo_privado.count({ where: { id: { in: ids } } })).toBe(3);
    } finally {
      await prisma.arquivo_privado.deleteMany({ where: { id: { in: ids } } });
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it('limpa lotes MFA expirados preservando lote válido e códigos ativos', async () => {
    const prisma = app.get(PrismaService);
    const ids = ['e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002'];
    const sessions: string[] = [];
    try {
      for (const [index, id] of ids.entries()) {
        const user = await prisma.usuarios.findUniqueOrThrow({ where: { id } });
        const raw = await app.get(SessionService).create(id, user.igreja_id, user.auth_version);
        sessions.push(raw);
        const session = await prisma.sessoes.findUniqueOrThrow({ where: { token_hash: createHash('sha256').update(raw).digest('hex') } });
        await prisma.mfa_recuperacao_pendente.create({ data: { usuario_id: id, sessao_id: session.id, codigos_cifrados: 'lote-sintetico', expira_em: new Date(Date.now() + (index ? 60_000 : -60_000)) } });
      }
      await prisma.mfa_recuperacao.create({ data: { usuario_id: ids[0], hash: createHash('sha256').update('codigo-sintetico').digest('hex') } });
      await app.get(MfaService).clearExpiredPending();
      expect(await prisma.mfa_recuperacao_pendente.findUnique({ where: { usuario_id: ids[0] } })).toBeNull();
      expect(await prisma.mfa_recuperacao_pendente.findUnique({ where: { usuario_id: ids[1] } })).not.toBeNull();
      expect(await prisma.mfa_recuperacao.count({ where: { usuario_id: ids[0], consumido_em: null } })).toBe(1);
    } finally {
      await prisma.mfa_recuperacao_pendente.deleteMany({ where: { usuario_id: { in: ids } } });
      await prisma.mfa_recuperacao.deleteMany({ where: { usuario_id: ids[0], hash: createHash('sha256').update('codigo-sintetico').digest('hex') } });
      for (const session of sessions) await app.get(SessionService).revoke(session);
    }
  });
  it('mostra falhas da fila somente ao administrador da igreja, sem payload ou tokens', async () => {
    const prisma = app.get(PrismaService);
    const churches = ['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002'];
    const actor = await prisma.usuarios.findUniqueOrThrow({ where: { id: 'e1000000-0000-4000-8000-000000000001' } });
    const requests: string[] = [];
    const confirmations: string[] = [];
    let managerId: string | undefined;
    let managerSession: string | undefined;
    const adminSession = await app.get(SessionService).create(actor.id, actor.igreja_id, actor.auth_version);
    try {
      for (const [index, church] of churches.entries()) {
        const access = await prisma.solicitacao_acesso.create({ data: { igreja_id: church, nome_usuario: 'Falha teste', email_login: `fila-${index}@example.invalid` } });
        requests.push(access.id);
        const confirmation = await prisma.confirmacao_acesso.create({ data: { solicitacao_id: access.id, hash: randomBytes(32).toString('hex'), expira_em: new Date(Date.now() + 60_000) } });
        confirmations.push(confirmation.id);
        await prisma.outbox_email.create({ data: { confirmacao_id: confirmation.id, estado: 'FALHOU', tentativas: 8, payload: 'segredo-sintetico' } });
      }
      const manager = await prisma.usuarios.create({ data: { igreja_id: churches[0], nome_usuario: 'Gestor fila', email_login: 'gestor-fila@example.invalid', senha_hash: 'inutilizavel', perfil: 'GESTOR', ativo: true } });
      managerId = manager.id;
      managerSession = await app.get(SessionService).create(manager.id, manager.igreja_id, manager.auth_version);
      await request(app.getHttpServer()).get('/usuarios/indicadores-fila').expect(401);
      await request(app.getHttpServer()).get('/usuarios/indicadores-fila').set('Cookie', `provisao_session=${managerSession}`).expect(403);
      const result = await request(app.getHttpServer()).get('/usuarios/indicadores-fila').set('Cookie', `provisao_session=${adminSession}`).expect(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.body.falhas).toBeGreaterThanOrEqual(1);
      expect(result.body.falhas_recentes).toEqual(expect.arrayContaining([expect.objectContaining({ destinatario: 'fila-0@example.invalid', tipo: 'CONFIRMACAO' })]));
      expect(JSON.stringify(result.body)).not.toContain('fila-1@example.invalid');
      expect(JSON.stringify(result.body)).not.toContain('segredo-sintetico');
      expect(JSON.stringify(result.body)).not.toContain('payload');
    } finally {
      if (managerSession) await app.get(SessionService).revoke(managerSession);
      if (managerId) await prisma.usuarios.delete({ where: { id: managerId } });
      await prisma.outbox_email.deleteMany({ where: { confirmacao_id: { in: confirmations } } });
      await prisma.confirmacao_acesso.deleteMany({ where: { id: { in: confirmations } } });
      await prisma.solicitacao_acesso.deleteMany({ where: { id: { in: requests } } });
      await app.get(SessionService).revoke(adminSession);
    }
  });
  it('recupera acesso MFA somente com autorização offline assinada e exige reinscrição', async () => {
    const prisma = app.get(PrismaService);
    const church = 'e0000000-0000-4000-8000-000000000001';
    const password = 'senha-emergencial-teste';
    const user = await prisma.usuarios.create({ data: { igreja_id: church, nome_usuario: 'Gestor recuperação', email_login: 'emergencia@example.invalid', senha_hash: await bcrypt.hash(password, 4), perfil: 'GESTOR', ativo: true } });
    const session = await app.get(SessionService).create(user.id, church, user.auth_version);
    const cookie = `provisao_session=${session}`;
    const write = (r: request.Test) => r.set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    const keys = generateKeyPairSync('ed25519');
    const previous = process.env.MFA_RECOVERY_PUBLIC_KEY;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'provisao-mfa-cli-'));
    process.env.MFA_RECOVERY_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    try {
      const setup = await write(request(app.getHttpServer()).post('/auth/mfa/setup')).send({ senha: password }).expect(201);
      await write(request(app.getHttpServer()).post('/auth/mfa/activate')).send({ codigo: generateSync({ secret: setup.body.secret }) }).expect(201);
      const now = Math.floor(Date.now() / 1000);
      const payload = { versao: 1 as const, igreja_id: church, usuario_id: user.id, emitido_em: now, expira_em: now + 300, nonce: randomBytes(32).toString('hex'), autoridade: 'Custodiante externo', motivo: 'Perda comprovada do autenticador e códigos.', assinatura: '' };
      const authorization = { ...payload, assinatura: sign(null, emergencyMessage(payload), keys.privateKey).toString('base64url') };
      await expect(app.get(EmergencyRecoveryService).recover({ ...authorization, motivo: 'Autorização adulterada para a conta.' })).rejects.toThrow();
      expect((await prisma.mfa_credencial.findUniqueOrThrow({ where: { usuario_id: user.id } })).estado).toBe('ATIVO');
      const { assinatura: _assinatura, ...unsigned } = payload;
      await fs.writeFile(path.join(directory, 'key.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      await fs.writeFile(path.join(directory, 'pedido.json'), JSON.stringify(unsigned), { mode: 0o600 });
      execFileSync(process.execPath, ['scripts/assinar-recuperacao.cjs', path.join(directory, 'key.pem'), path.join(directory, 'pedido.json'), path.join(directory, 'autorizacao.json')], { stdio: 'pipe' });
      execFileSync(process.execPath, ['dist/src/mfa/recovery-cli.js', path.join(directory, 'autorizacao.json')], { stdio: 'pipe', env: process.env });
      await expect(app.get(EmergencyRecoveryService).recover(authorization)).rejects.toThrow();
      expect(await prisma.mfa_credencial.findUnique({ where: { usuario_id: user.id } })).toBeNull();
      expect((await prisma.usuarios.findUniqueOrThrow({ where: { id: user.id } })).mfa_reinscricao_obrigatoria).toBe(true);
      expect(await prisma.mfa_recuperacao_emergencial.count({ where: { usuario_id: user.id, igreja_id: church } })).toBe(1);
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', cookie).expect(401);
      const login = await request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ igreja_id: church, login: user.email_login, senha: password }).expect(200);
      expect(login.body.mfa_enrollment_required).toBe(true);
      const newCookie = login.headers['set-cookie'][0].split(';')[0];
      await request(app.getHttpServer()).get('/pessoas').set('Cookie', newCookie).expect(403);
      const reenrollment = await request(app.getHttpServer()).post('/auth/mfa/setup').set('Cookie', newCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ senha: password }).expect(201);
      const activation = await request(app.getHttpServer()).post('/auth/mfa/activate').set('Cookie', newCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ codigo: generateSync({ secret: reenrollment.body.secret }) }).expect(201);
      expect((await prisma.usuarios.findUniqueOrThrow({ where: { id: user.id } })).mfa_reinscricao_obrigatoria).toBe(false);
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', newCookie).expect(401);
      const finalLogin = await request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send({ igreja_id: church, login: user.email_login, senha: password, mfa_code: activation.body.recovery_codes[0] }).expect(200);
      await request(app.getHttpServer()).get('/pessoas').set('Cookie', finalLogin.headers['set-cookie'][0].split(';')[0]).expect(200);
    } finally {
      if (previous === undefined) delete process.env.MFA_RECOVERY_PUBLIC_KEY; else process.env.MFA_RECOVERY_PUBLIC_KEY = previous;
      await fs.rm(directory, { recursive: true, force: true });
      await prisma.mfa_recuperacao_emergencial.deleteMany({ where: { usuario_id: user.id } });
      await prisma.usuarios.delete({ where: { id: user.id } });
    }
  });
  it('nega consulta sem autenticação', async () => {
    await request(app.getHttpServer()).get('/usuarios').expect(401);
  });
});
