import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { PrismaService } from '../src/prisma/prisma.service';

const integracao = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const civil = (data: string) => new Date(`${data}T00:00:00Z`);

integracao('E02: seleção eleitoral e retirada da indicação', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const igreja = randomUUID(), operador = randomUUID(), candidato = randomUUID(), menor = randomUUID(), foraDoRol = randomUUID();
  let conselho: { id: string; documento_id: string }, assembleia: { id: string; documento_id: string };
  const antes = { governanca: process.env.FEATURE_GOVERNANCA, secretaria: process.env.FEATURE_SECRETARIA };

  const http = (metodo: 'get' | 'post', path: string) => request(app.getHttpServer())[metodo](path)
    .set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');

  async function criarAta(contexto_id: string, dia: string) {
    const modelo = await prisma.modelo_documento.create({ data: { igreja_id: igreja, contexto_id, nome: dia } });
    const versao = await prisma.modelo_documento_versao.create({
      data: { igreja_id: igreja, contexto_id, modelo_id: modelo.id, numero: 1, tipo: 'ATA', finalidade: 'Teste', configuracao: {} },
    });
    const doc = await prisma.documento.create({
      data: { igreja_id: igreja, contexto_id, tipo: 'ATA', estado: 'APROVADO', perfil: 'TESTE' },
    });
    return prisma.documento_versao.create({
      data: { igreja_id: igreja, contexto_id, documento_id: doc.id, numero: 1, modelo_versao_id: versao.id, assunto: dia, data_documento: civil(dia), conteudo: {} },
      select: { id: true, documento_id: true },
    });
  }

  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') {
      throw new Error('Exige banco descartável E00.');
    }
    process.env.FEATURE_GOVERNANCA = 'true';
    process.env.FEATURE_SECRETARIA = 'true';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.igreja.create({ data: { id: igreja, nome: 'Igreja de teste de indicação' } });
    await prisma.pessoas.createMany({ data: [
      { id: candidato, igreja_id: igreja, nome_completo: 'Candidato Sintético', sexo: 'MASCULINO', data_nascimento: civil('2006-08-01') },
      { id: menor, igreja_id: igreja, nome_completo: 'Menor Sintético', sexo: 'MASCULINO', data_nascimento: civil('2010-01-01') },
      { id: foraDoRol, igreja_id: igreja, nome_completo: 'Ex-Membro Sintético', sexo: 'MASCULINO', data_nascimento: civil('1990-01-01') },
    ] });
    await prisma.eventos_membresia.createMany({ data: [candidato, menor, foraDoRol].map(pessoa_id => ({
      igreja_id: igreja, pessoa_id, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: civil('2023-01-01'),
    })) });
    await prisma.eventos_membresia.create({ data: {
      igreja_id: igreja, pessoa_id: foraDoRol, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: civil('2024-08-02'),
    } });
    const usuario = await prisma.usuarios.create({
      data: { id: operador, igreja_id: igreja, perfil: 'COMUM', nome_usuario: 'Gestor sintético', email_login: `${operador}@example.invalid`, senha_hash: 'teste' },
    });
    cookie = `provisao_session=${await app.get(SessionService).create(operador, igreja, usuario.auth_version)}`;
    const orgao = await prisma.orgao_interno.create({ data: { igreja_id: igreja, tipo: 'CONSELHO', constituicao: 'OFICIAL',
      nome: 'Conselho', sigla: 'CON', finalidade: 'Teste', data_criacao: civil('2023-01-01'), criador_id: operador,
      instituidor_id: candidato, evidencia_instituicao: 'Teste',
    } });
    const [ctxConselho, ctxAssembleia] = await Promise.all([
      prisma.contexto_secretaria.create({ data: { igreja_id: igreja, tipo: 'ORGAO', orgao_id: orgao.id, nome: 'Conselho', sigla: 'CON' } }),
      prisma.contexto_secretaria.create({ data: { igreja_id: igreja, tipo: 'ASSEMBLEIA_GERAL', nome: 'Assembleia', sigla: 'AG' } }),
    ]);
    conselho = await criarAta(ctxConselho.id, '2024-08-01');
    assembleia = await criarAta(ctxAssembleia.id, '2024-09-01');
  });

  afterAll(async () => {
    if (antes.governanca === undefined) delete process.env.FEATURE_GOVERNANCA;
    else process.env.FEATURE_GOVERNANCA = antes.governanca;
    if (antes.secretaria === undefined) delete process.env.FEATURE_SECRETARIA;
    else process.env.FEATURE_SECRETARIA = antes.secretaria;
    if (app) await app.close();
  });

  it('permite consultar atas e candidatos e encerra o fluxo de indicações', async () => {
    const inicio = '/oficiais/indicacoes';
    const atas = await http('get', `${inicio}/atas`).query({ tipo: 'CONSELHO' }).expect(200);
    expect(atas.body.map((a: { versao_id: string }) => a.versao_id)).toEqual([conselho.id]);
    const aptos = await http('get', `${inicio}/candidatos`).query({ ata: conselho.id }).expect(200);
    expect(aptos.body).toEqual([{ id: candidato, nome_completo: 'Candidato Sintético' }]);

    const dados = { pessoa_id: candidato, oficio: 'PRESBITERO_REGENTE' as const, ata_conselho_versao_id: conselho.id };
    const existente = await prisma.indicacao_eleicao_oficial.create({ data: {
      ...dados, igreja_id: igreja, registrado_por_id: operador, data_assembleia: civil('2024-09-01'),
    } });
    await http('post', inicio).send({ ...dados, data_assembleia: '2024-09-01' }).expect(404);
    await http('get', `${inicio}/historico`).expect(404);
    await http('post', `${inicio}/mandatos`).send({
      indicacao_id: existente.id, ata_assembleia_versao_id: assembleia.id, data_posse: '2024-09-08',
    }).expect(410);

    expect(await prisma.indicacao_eleicao_oficial.count({ where: { igreja_id: igreja } })).toBe(1);
    expect(await prisma.mandato_oficial.count({ where: { igreja_id: igreja } })).toBe(0);
  });
});
