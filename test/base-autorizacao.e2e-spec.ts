import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { usuarios_perfil } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { PrismaService } from '../src/prisma/prisma.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
integration('Base de autorização por conta e por igreja', () => {
  let db: PrismaService, app: INestApplication;
  const igreja = randomUUID(), outra = randomUUID();
  const fundamento = 'Ata de conferência da identidade e do serviço';
  const antes = new Date('2020-01-01');
  const cookie = new Map<string,string>();
  let admin: string, revisor: string, comum: string, alternativa: string, auditor: string, outroAdmin: string, mesmaPessoaAdmin: string;
  let pessoa: string, modelo: string, presidencia: string;
  const http = (id: string, verbo: 'get' | 'post' | 'patch', rota: string) => request(app.getHttpServer())[verbo](rota)
    .set('Cookie', cookie.get(id)!).set('Origin','http://localhost:3001').set('X-Provisao-Request','1');
  const me = async (id: string) => (await http(id,'get','/autorizacao/me').expect(200)).body;
  const atuar = (id: string | null, anterior: string | null, operador = admin) => http(operador,'post','/autorizacao/conta-atuacao')
    .send({ conta_id: id, anterior_id: anterior, pessoa_id: pessoa, fundamento });
  const conceder = (id: string, acao = 'PESSOAS_CONSULTAR', operador = admin, fim: string | null = null) =>
    http(operador,'post','/autorizacao/contas/'+id+'/atribuicoes').send({ acao, fundamento, inicio: antes.toISOString(), fim });
  async function criarPessoa(igreja_id = igreja) {
    return (await db.pessoas.create({ data: { igreja_id, nome_completo: 'Pessoa de ensaio', sexo: 'MASCULINO', data_nascimento: antes } })).id;
  }
  async function criarConta(perfil: usuarios_perfil, igreja_id = igreja, pessoa_id?: string) {
    const id = randomUUID();
    await db.usuarios.create({ data: { id, igreja_id, pessoa_id: pessoa_id ?? await criarPessoa(igreja_id), nome_usuario: 'Conta de ensaio',
      perfil, senha_hash: 'inutilizavel', email_login: id+'@example.invalid' } });
    cookie.set(id,'provisao_session='+await app.get(SessionService).create(id, igreja_id, 0));
    return id;
  }
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public')
      throw new Error('Exige banco descartável E00.');
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    db = app.get(PrismaService);
    for (const id of [igreja, outra]) await db.igreja.create({ data: { id, nome: 'Igreja de ensaio', mfa_obrigatorio: false } });
    await db.$executeRaw`SELECT instalar_estrutura_institucional(${igreja})`;
    pessoa = await criarPessoa();
    admin = await criarConta('ADMINISTRADOR'); revisor = await criarConta('ADMINISTRADOR');
    comum = await criarConta('COMUM', igreja, pessoa); alternativa = await criarConta('COMUM', igreja, pessoa);
    mesmaPessoaAdmin = await criarConta('ADMINISTRADOR', igreja, pessoa);
    auditor = await criarConta('AUDITOR'); outroAdmin = await criarConta('ADMINISTRADOR', outra);
    const pastor = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo: 'PRESBITERO_DOCENTE' } });
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: pastor.id, tipo: 'ORDENACAO', data_efeito: antes, ordem: 1, autoridade: 'Concílio', evidencia: fundamento } });
    await db.vinculo_pastoral.create({ data: { igreja_id: igreja, oficial_id: pastor.id, modalidade: 'Pastor', concilio: 'Concílio', ato: 'Posse', evidencia: fundamento, data_inicio: antes, exercicio_institucional: true } });
    presidencia = (await db.presidencia_conselho.create({ data: { igreja_id: igreja, oficial_id: pastor.id, inicio: antes, registrado_por: admin, evidencia: fundamento } })).id;
    const conselho = await db.contexto_secretaria.findFirstOrThrow({ where: { igreja_id: igreja, orgao: { tipo: 'CONSELHO' } } });
    modelo = (await db.modelo_documento.create({ data: { igreja_id: igreja, contexto_id: conselho.id, nome: 'Modelo de ensaio' } })).id;
    await db.modelo_documento_versao.create({ data: { modelo_id: modelo, contexto_id: conselho.id, igreja_id: igreja, tipo: 'OUTRO', finalidade: 'CARTA', numero: 1,
      configuracao: { perfil: 'CARTA', contexto: 'ORGAO', motivador: 'OPCIONAL', resolucoes: 'OPCIONAL', campos_obrigatorios: [], papeis_obrigatorios: [], cargos_obrigatorios: [],
        atuacao: { criar: ['PRESIDENCIA_CONSELHO'], preparar: [], assinar: [] } } } });
  });
  afterAll(async () => { if (app) await app.close(); });

  it('compara a regra legada e aplica a atribuição na conta comum', async () => {
    await http(admin,'get','/pessoas').expect(200);
    await http(comum,'get','/pessoas').expect(403);
    const r = await conceder(comum).expect(201);
    expect((await me(comum)).servicos_propostos).toContainEqual(expect.objectContaining({ acao: 'PESSOAS_CONSULTAR', permite: true }));
    await http(comum,'get','/pessoas').expect(200);
    await http(comum,'get','/contas').expect(403);
    const eventos = (await http(admin,'get','/autorizacao/historico').expect(200)).body.itens;
    expect(eventos).toContainEqual(expect.objectContaining({ destinatario_id: comum, fundamento: 'ATRIBUICAO_VIGENTE',
      dados: expect.objectContaining({ legado: false, proposta: true, origem_proposta: r.body.id }) }));
    expect(eventos).toContainEqual(expect.objectContaining({ destinatario_id: admin, fundamento: 'SEM_ATRIBUICAO',
      dados: expect.objectContaining({ legado: true, proposta: false }) }));
    await http(admin,'post','/autorizacao/atribuicoes/'+r.body.id+'/revogar').send({ fundamento }).expect(201);
    expect((await me(comum)).servicos_propostos).toContainEqual(expect.objectContaining({ acao: 'PESSOAS_CONSULTAR', permite: false, motivo: 'ATRIBUICAO_REVOGADA' }));
  });

  it('bloqueia autoconcessão pelos dois logins, isolamento, escrita de auditor e autoridade por perfil para assinar', async () => {
    await conceder(comum, 'PESSOAS_CONSULTAR', mesmaPessoaAdmin).expect(403);
    await atuar(comum, null, mesmaPessoaAdmin).expect(403);
    await conceder(comum, 'PESSOAS_CONSULTAR', outroAdmin).expect(404);
    await conceder(auditor, 'PESSOAS_CADASTRAR').expect(400);
    await conceder(comum, 'ASSINAR_DOCUMENTO').expect(400);
    for (const id of [admin, auditor]) {
      expect((await me(id)).cargos_propostos).toEqual([]);
    }
    await http(comum,'get','/autorizacao/historico').expect(403);
    await http(outroAdmin,'get','/autorizacao/contas/'+comum).expect(404);
  });

  it('serializa escolhas e concessões concorrentes e exige CSRF no comando de troca', async () => {
    const pessoaLocal = await criarPessoa();
    const primeiro = await criarConta('COMUM', igreja, pessoaLocal), segundo = await criarConta('COMUM', igreja, pessoaLocal);
    const body = (id: string) => ({ conta_id: id, anterior_id: null, pessoa_id: pessoaLocal, fundamento });
    await request(app.getHttpServer()).post('/autorizacao/conta-atuacao').set('Cookie', cookie.get(admin)!).send(body(primeiro)).expect(403);
    const disputas = await Promise.all([primeiro, segundo].map(id => http(admin,'post','/autorizacao/conta-atuacao').send(body(id))));
    expect(disputas.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await db.usuarios.count({ where: { pessoa_id: pessoaLocal, igreja_id: igreja, conta_atuacao: true } })).toBe(1);
    const concessoes = await Promise.all([conceder(primeiro), conceder(primeiro)]);
    expect(concessoes.map(r => r.status).sort()).toEqual([201, 409]);
  });

  it('exige revisão independente da presidência e transfere os poderes entre sessões abertas', async () => {
    const conferir = (id: string, etapa: string) => http(id,'post','/autorizacao/presidencias/'+presidencia+'/'+etapa).send({ fundamento });
    const comparar = async (id: string) => (await http(admin,'get','/autorizacao/contas/'+id+'/modelos/'+modelo).expect(200)).body[0];
    await atuar(comum, null).expect(201);
    await conferir(admin,'encaminhar').expect(201);
    expect((await comparar(comum)).proposta).toMatchObject({ permite: false, motivo: 'PRESIDENCIA_SEM_CONFERENCIA' });
    await conferir(admin,'conferir').expect(403);
    await conferir(mesmaPessoaAdmin,'conferir').expect(403);
    await conferir(revisor,'conferir').expect(403);
    await conceder(revisor, 'PRESIDENCIA_CONFERIR').expect(201);
    await conferir(revisor,'conferir').expect(201);
    expect(await comparar(comum)).toMatchObject({ legado: false, proposta: { permite: true, origem: presidencia } });
    expect((await me(comum)).cargos_propostos).toContainEqual(expect.objectContaining({ cargo: 'Presidente do Conselho', origem_id: presidencia }));
    expect((await me(alternativa)).cargos_propostos).toEqual([]);
    await atuar(alternativa, comum).expect(201);
    await atuar(comum, null).expect(409);
    expect((await me(comum)).cargos_propostos).toEqual([]);
    expect((await comparar(alternativa)).proposta.permite).toBe(true);
    await db.presidencia_conselho.update({ where: { id: presidencia }, data: { fim: new Date() } });
    expect((await me(alternativa)).cargos_propostos).toEqual([]);
  });

  it('respeita o fim exclusivo e a troca de vínculo sem reativar atribuições antigas', async () => {
    const r = await conceder(alternativa, 'AUDITORIA_CONSULTAR').expect(201);
    await db.atribuicao_servico.update({ where: { id: r.body.id }, data: { fim: new Date() } });
    expect((await me(alternativa)).servicos_propostos).toContainEqual(expect.objectContaining({ acao: 'AUDITORIA_CONSULTAR', motivo: 'ATRIBUICAO_EXPIRADA' }));
    await conceder(alternativa, 'PESSOAS_CADASTRAR').expect(201);
    const vincular = (valor: string | null) => http(admin,'patch','/usuarios/'+alternativa+'/pessoa').send({ pessoa_id: valor });
    await vincular(null).expect(200); await vincular(pessoa).expect(200);
    const dados = await me(alternativa);
    expect(dados.conta_atuacao).toBe(false);
    expect(dados.servicos_propostos).toContainEqual(expect.objectContaining({ acao: 'PESSOAS_CADASTRAR', motivo: 'VINCULO_ALTERADO', permite: false }));
    const e = await db.evento_autorizacao.findFirstOrThrow({ where: { igreja_id: igreja, acao: 'CONCEDER_SERVICO' } });
    await expect(db.evento_autorizacao.update({ where: { id: e.id }, data: { fundamento: 'Outro' } })).rejects.toThrow(/imutável/);
  });
});
