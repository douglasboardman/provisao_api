import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
import { dataCivilNoFuso, hojeDaIgreja } from '../src/orgaos/relogio-igreja';
import { transacaoSerializavel } from '../src/orgaos/idempotencia';
import { FusoIgrejaService } from '../src/orgaos/fuso-igreja.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;

integration('E03: configuração de fuso', () => {
  let app: INestApplication, adminCookie: string, gestorCookie: string, outraCookie: string;
  const igreja = randomUUID(), outra = randomUUID(), admin = randomUUID(), gestor = randomUUID(), adminOutra = randomUUID(), chave = randomUUID(), chaveOutra = randomUUID();
  const pessoaGestor = randomUUID(), pessoaParticipante = randomUUID(), orgao = randomUUID();
  const flags = [process.env.FEATURE_GOVERNANCA, process.env.FEATURE_ORGAOS, process.env.FEATURE_ORGAOS_GESTAO];
  const patch = (cookie: string) => request(app.getHttpServer()).patch('/orgaos/gestao/fuso').set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = modulo.createNestApplication(); await app.init();
    const p = app.get(PrismaService);
    await p.igreja.createMany({ data: [{ id: igreja, nome: 'Igreja de fuso sintética' }, { id: outra, nome: 'Outra igreja sintética' }] });
    for (const [id, igrejaId, perfil, salvar] of [[admin, igreja, 'ADMINISTRADOR', (s: string) => { adminCookie = s; }], [gestor, igreja, 'GESTOR', (s: string) => { gestorCookie = s; }], [adminOutra, outra, 'ADMINISTRADOR', (s: string) => { outraCookie = s; }]] as const) {
      const usuario = await p.usuarios.create({ data: { id, igreja_id: igrejaId, nome_usuario: 'Usuário sintético', email_login: `${id}@example.invalid`, senha_hash: 'inutilizavel', perfil } });
      salvar(`provisao_session=${await app.get(SessionService).create(id, igrejaId, usuario.auth_version)}`);
    }
    await p.pessoas.createMany({ data: [pessoaGestor, pessoaParticipante].map(id => ({ id, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1980-01-01'), sexo: 'FEMININO' as const })) });
    await p.usuarios.update({ where: { id: gestor }, data: { pessoa_id: pessoaGestor } });
    await p.competencia_unidades.create({ data: { igreja_id: igreja, usuario_id: gestor, pessoa_id: pessoaGestor, registrado_por: admin, inicio: new Date('2020-01-01'), autoridade: 'Teste', evidencia: 'Teste' } });
    await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoaParticipante, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2020-01-01') } });
    await p.orgao_interno.create({ data: { id: orgao, igreja_id: igreja, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'DESIGNACAO', nome: 'Unidade sintética', finalidade: 'Teste', data_criacao: new Date('2020-01-01'), criador_id: gestor, instituidor_id: pessoaGestor, evidencia_instituicao: 'Teste' } });
  });
  afterAll(async () => {
    for (const [i, key] of ['FEATURE_GOVERNANCA', 'FEATURE_ORGAOS', 'FEATURE_ORGAOS_GESTAO'].entries()) { if (flags[i] === undefined) delete process.env[key]; else process.env[key] = flags[i]; }
    if (!app) return;
    const p = app.get(PrismaService);
    await p.ato_orgao.deleteMany({ where: { orgao_id: orgao } });
    await p.membro_orgao.deleteMany({ where: { orgao_id: orgao } });
    await p.orgao_interno.deleteMany({ where: { id: orgao } });
    await p.requisicao_institucional.deleteMany({ where: { igreja_id: { in: [igreja, outra] } } });
    await p.logs_atividades.deleteMany({ where: { igreja_id: { in: [igreja, outra] } } });
    await p.configuracao_fuso_igreja.deleteMany({ where: { igreja_id: { in: [igreja, outra] } } });
    await p.competencia_unidades.deleteMany({ where: { igreja_id: igreja } });
    await p.usuarios.deleteMany({ where: { id: { in: [admin, gestor, adminOutra] } } });
    await p.eventos_membresia.deleteMany({ where: { pessoa_id: pessoaParticipante } });
    await p.pessoas.deleteMany({ where: { id: { in: [pessoaGestor, pessoaParticipante] } } });
    await p.igreja.deleteMany({ where: { id: { in: [igreja, outra] } } });
    await app.close();
  });
  it('protege configuração, valida IANA, conserva idempotência e isola igrejas', async () => {
    process.env.FEATURE_GOVERNANCA = 'true'; process.env.FEATURE_ORGAOS = 'true'; delete process.env.FEATURE_ORGAOS_GESTAO;
    await request(app.getHttpServer()).get('/orgaos/gestao/fuso').set('Cookie', adminCookie).expect(404);
    process.env.FEATURE_ORGAOS_GESTAO = 'true';
    await request(app.getHttpServer()).get('/orgaos/gestao/fuso').expect(401);
    await request(app.getHttpServer()).get('/orgaos/gestao/fuso').set('Cookie', gestorCookie).expect(403);
    const inicial = await request(app.getHttpServer()).get('/orgaos/gestao/fuso').set('Cookie', adminCookie).expect(200);
    expect(inicial.body.configuracao).toBeNull();
    expect(inicial.body.em_uso_pelos_orgaos).toBe(true);
    expect(inicial.headers['cache-control']).toBe('private, no-store');
    const relogioInicial = await request(app.getHttpServer()).get('/orgaos/relogio').set('Cookie', gestorCookie).expect(200);
    expect(relogioInicial.body).toMatchObject({ fuso_iana: null, data_no_fuso: null });
    expect(relogioInicial.body.data_operacional).toBe(relogioInicial.body.data_utc);
    expect(relogioInicial.headers['cache-control']).toBe('private, no-store');
    const dados = { fuso_iana: 'America/Sao_Paulo', autoridade: 'Conselho', evidencia: 'Registro sintético', idempotencia: chave };
    await patch(gestorCookie).send(dados).expect(403);
    await request(app.getHttpServer()).patch('/orgaos/gestao/fuso').set('Cookie', adminCookie).send(dados).expect(403);
    await patch(adminCookie).send({ ...dados, fuso_iana: 'Fuso/Inexistente' }).expect(400);
    const [primeira, repetida] = await Promise.all([patch(adminCookie).send(dados).expect(200), patch(adminCookie).send(dados).expect(200)]);
    expect(repetida.body).toEqual(primeira.body);
    expect(primeira.body).toEqual({ id: igreja, fuso_iana: dados.fuso_iana });
    const relogioConfigurado = await request(app.getHttpServer()).get('/orgaos/relogio').set('Cookie', gestorCookie).expect(200);
    expect(relogioConfigurado.body.fuso_iana).toBe('America/Sao_Paulo');
    expect(relogioConfigurado.body.data_no_fuso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(relogioConfigurado.body.data_operacional).toBe(relogioConfigurado.body.data_no_fuso);
    expect((await request(app.getHttpServer()).get('/orgaos/relogio').set('Cookie', outraCookie).expect(200)).body.fuso_iana).toBeNull();
    await patch(adminCookie).send({ ...dados, fuso_iana: 'UTC' }).expect(409);
    const p = app.get(PrismaService);
    expect(await p.logs_atividades.count({ where: { igreja_id: igreja, tabela_afetada: 'configuracao_fuso_igreja' } })).toBe(1);
    expect((await request(app.getHttpServer()).get('/orgaos/gestao/fuso').set('Cookie', outraCookie).expect(200)).body.configuracao).toBeNull();
    await patch(adminCookie).send({ ...dados, fuso_iana: 'UTC', idempotencia: chaveOutra }).expect(200);
    expect((await patch(adminCookie).send(dados).expect(200)).body).toEqual(primeira.body);
    const atual = await request(app.getHttpServer()).get('/orgaos/gestao/fuso').set('Cookie', adminCookie).expect(200);
    expect(atual.body.configuracao.fuso_iana).toBe('UTC');
    expect(atual.body.em_uso_pelos_orgaos).toBe(true);
    expect(JSON.stringify(atual.body)).not.toContain('Registro sintético');
  });

  it('retenta a transação que esperou uma alteração concorrente de fuso', async () => {
    const p = app.get(PrismaService);
    let sinalizar!: () => void, liberar!: () => void, leitorPronto!: () => void;
    const pronto = new Promise<void>(r => { sinalizar = r; }), continuar = new Promise<void>(r => { liberar = r; }), leituraIniciada = new Promise<void>(r => { leitorPronto = r; });
    const fuso = 'Pacific/Kiritimati';
    const alteracao = p.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':fuso-orgao'}, 0))`;
      await tx.$executeRaw`UPDATE igreja SET updated_at = updated_at WHERE id = ${igreja}`;
      await tx.configuracao_fuso_igreja.update({ where: { igreja_id: igreja }, data: { fuso_iana: fuso } });
      sinalizar(); await continuar;
    });
    await pronto;
    let tentativas = 0;
    const leitura = transacaoSerializavel(p, async tx => {
      tentativas++;
      await tx.usuarios.findFirst({ where: { id: gestor, igreja_id: igreja }, select: { id: true } });
      leitorPronto();
      return hojeDaIgreja(tx, igreja);
    });
    await leituraIniciada;
    await new Promise(resolve => setTimeout(resolve, 100));
    liberar();
    await alteracao;
    expect(await leitura).toBe(dataCivilNoFuso(new Date(), fuso));
    expect(tentativas).toBeGreaterThan(1);
  });

  it('registra participação na data da igreja quando ela difere de UTC', async () => {
    const instante = new Date(), utc = dataCivilNoFuso(instante, 'UTC');
    const fuso = ['Pacific/Kiritimati', 'Etc/GMT+12'].find(z => dataCivilNoFuso(instante, z) !== utc)!;
    expect(fuso).toBeDefined();
    await patch(adminCookie).send({ fuso_iana: fuso, autoridade: 'Conselho', evidencia: 'Teste', idempotencia: randomUUID() }).expect(200);
    const hojeIgreja = dataCivilNoFuso(new Date(), fuso);
    const url = `/orgaos/gestao/${orgao}/participacoes/incluir`;
    const entrada = { pessoa_id: pessoaParticipante, data_efeito: hojeIgreja, evidencia: 'Teste', idempotencia: randomUUID() };
    const enviar = (corpo: typeof entrada) => request(app.getHttpServer()).post(url).set('Cookie', gestorCookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send(corpo);
    await enviar({ ...entrada, data_efeito: utc, idempotencia: randomUUID() }).expect(400);
    const primeiro = await enviar(entrada).expect(201);
    expect((await enviar(entrada).expect(201)).body).toEqual(primeiro.body);
    const registro = await app.get(PrismaService).membro_orgao.findUniqueOrThrow({ where: { id: primeiro.body.membro_id } });
    expect(registro.inicio.toISOString().slice(0, 10)).toBe(hojeIgreja);
  });

  it('aguarda o ato que já está usando o fuso antes de alterar a configuração', async () => {
    const p = app.get(PrismaService);
    let sinalizar!: () => void, liberar!: () => void, concluido = false;
    const pronto = new Promise<void>(r => { sinalizar = r; }), continuar = new Promise<void>(r => { liberar = r; });
    const leitura = p.$transaction(async tx => { await hojeDaIgreja(tx, igreja); sinalizar(); await continuar; });
    await pronto;
    const alteracao = app.get(FusoIgrejaService).registrar(igreja, admin, { fuso_iana: 'UTC', autoridade: 'Conselho', evidencia: 'Teste', idempotencia: randomUUID() }).then(() => { concluido = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(concluido).toBe(false);
    } finally { liberar(); }
    await leitura; await alteracao;
    expect(concluido).toBe(true);
  });

  it('bloqueia o cálculo de atos se a configuração armazenada for inválida', async () => {
    const p = app.get(PrismaService);
    await p.configuracao_fuso_igreja.update({ where: { igreja_id: igreja }, data: { fuso_iana: 'Fuso/Inexistente' } });
    const resposta = await request(app.getHttpServer()).get('/orgaos/relogio').set('Cookie', adminCookie).expect(200);
    expect(resposta.body.data_operacional).toBeNull();
    await expect(p.$transaction(tx => hojeDaIgreja(tx, igreja))).rejects.toThrow('Fuso da igreja inválido');
  });
});
