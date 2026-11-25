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

  it('permite conceder e revogar um perfil elegível sem conceder poderes de administração à presidência', async () => {
    const ano = new Date().getUTCFullYear();
    const inicio = new Date(`${ano - 1}-01-01`);
    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);
    const termino = new Date(`${ano + 1}-12-31`);
    const cargo = await db.cargo_orgao.findFirstOrThrow({
      where: { igreja_id: igreja, codigo: { in: ['PRIMEIRO_SECRETARIO', 'SECRETARIO'] }, orgao: { tipo: 'CONSELHO' } },
    });
    const titular = await criarPessoa();
    const conta = await criarConta('COMUM', igreja, titular);
    const segundaConta = await criarConta('COMUM', igreja, titular);
    const semCargo = await criarConta('COMUM');
    await db.usuarios.updateMany({ where: { id: { in: [conta, semCargo] } }, data: { conta_atuacao: true } });
    const oficial = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: titular, tipo: 'PRESBITERO_REGENTE' } });
    await db.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: titular, data_evento: inicio,
      tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE' } });
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, tipo: 'ORDENACAO', data_efeito: inicio,
      ordem: 1, autoridade: 'Conselho', evidencia: fundamento } });
    const mandato = await db.mandato_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, data_eleicao: inicio,
      data_posse: inicio, termino_previsto: termino, autoridade: 'Assembleia', evidencia: fundamento, avaliacao_eleicao: {} } });
    const ocupacao = await db.ocupacao_cargo.create({ data: { igreja_id: igreja, pessoa_id: titular, cargo_id: cargo.id, orgao_id: cargo.orgao_id,
      inicio, termino_previsto: termino } });

    const pessoaPastor = await criarPessoa();
    const presidente = await criarConta('COMUM', igreja, pessoaPastor);
    await db.usuarios.update({ where: { id: presidente }, data: { conta_atuacao: true } });
    const pastor = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoaPastor, tipo: 'PRESBITERO_DOCENTE' } });
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: pastor.id, tipo: 'ORDENACAO', data_efeito: inicio,
      ordem: 1, autoridade: 'Concílio', evidencia: fundamento } });
    await db.vinculo_pastoral.create({ data: { igreja_id: igreja, oficial_id: pastor.id, modalidade: 'Pastor', concilio: 'Concílio',
      ato: 'Posse', evidencia: fundamento, data_inicio: inicio, exercicio_institucional: true } });
    const presidenteRegistro = await db.presidencia_conselho.create({ data: { igreja_id: igreja, oficial_id: pastor.id,
      inicio: hoje, registrado_por: admin, evidencia: fundamento } });

    const modelos = '/autorizacao/modelos-atuacao';
    const entrada = { nome: ' Perfil   Secretário ', requisito: { tipo: 'cargo', id: cargo.id },
      acoes: ['AUDITORIA_CONSULTAR', 'PESSOAS_CONSULTAR'], fundamento };
    await http(presidente, 'get', modelos).expect(403);
    await db.evento_autorizacao.create({ data: { igreja_id: igreja, operador_id: revisor, pessoa_id: pessoaPastor,
      acao: 'PRESIDENCIA_CONFERIDA', recurso_id: presidenteRegistro.id, fundamento, dados: {} } });
    await http(presidente, 'post', modelos).send(entrada).expect(403);
    await http(admin, 'post', modelos).send({ ...entrada, acoes: ['PRESIDENCIA_CONFERIR'] }).expect(400);
    const { body: modeloCriado } = await http(admin, 'post', modelos).send(entrada).expect(201);
    expect(modeloCriado.nome).toBe('Perfil Secretário');
    await http(admin, 'post', modelos).send({ ...entrada, nome: 'perfil secretário' }).expect(409);
    expect((await http(presidente, 'get', modelos).expect(200)).body).toMatchObject({ pode_criar: false, modelos: [expect.objectContaining({ id: modeloCriado.id })] });
    expect((await http(outroAdmin, 'get', modelos).expect(200)).body.modelos).toEqual([]);

    const rota = modelos + '/' + modeloCriado.id + '/concessoes';
    const previa = (operador: string, usuario_id: string) => http(operador, 'post', rota + '/previa').send({ usuario_id });
    await http(outroAdmin, 'get', rota).expect(404);
    await previa(presidente, presidente).expect(403);
    await previa(presidente, segundaConta).expect(400);
    await previa(presidente, semCargo).expect(400);
    expect((await http(presidente, 'get', rota).expect(200)).body.contas.map(c => c.id)).toEqual([conta]);
    await http(conta, 'get', '/pessoas').expect(403);
    await conceder(conta, 'AUDITORIA_CONSULTAR').expect(201);
    const { body: proposta } = await previa(presidente, conta).expect(201);
    expect(proposta.itens).toEqual([
      expect.objectContaining({ acao: 'AUDITORIA_CONSULTAR', sobreposta: true }),
      expect.objectContaining({ acao: 'PESSOAS_CONSULTAR', sobreposta: false }),
    ]);
    const aplicar = (operador: string, previa: string) => http(operador, 'post', rota).send({ usuario_id: conta, previa, fundamento });
    const { body: { id: concessao } } = await aplicar(presidente, proposta.previa).expect(201);
    await aplicar(admin, proposta.previa).expect(409);
    await http(conta, 'get', '/pessoas').expect(200);
    const ato = await db.evento_autorizacao.findFirstOrThrow({ where: { recurso_id: concessao, acao: 'ATRIBUIR_MODELO_ATUACAO' } });
    expect(ato.operador_id).toBe(presidente);
    expect(ato.dados).toMatchObject({ qualificacao_id: ocupacao.id, acoes: ['PESSOAS_CONSULTAR'] });

    const { body: atribuicoes } = await http(admin, 'get', '/autorizacao/contas/' + conta).expect(200);
    const vinculada = atribuicoes.atribuicoes.find(a => a.concessao_modelo_id === concessao);
    await http(admin, 'post', '/autorizacao/atribuicoes/' + vinculada.id + '/revogar').send({ fundamento }).expect(400);
    const revogar = '/autorizacao/concessoes-modelo/' + concessao + '/revogar';
    await http(presidente, 'post', revogar).send({ fundamento }).expect(201);
    await http(conta, 'get', '/pessoas').expect(403);
    expect((await me(conta)).servicos_propostos).toContainEqual(expect.objectContaining({ acao: 'AUDITORIA_CONSULTAR', permite: true }));

    const { body: nova } = await previa(admin, conta).expect(201);
    const respostas = await Promise.all([aplicar(admin, nova.previa), aplicar(revisor, nova.previa)]);
    expect(respostas.map(r => r.status).sort()).toEqual([201, 409]);
    await db.ocupacao_cargo.update({ where: { id: ocupacao.id }, data: { fim: hoje, fim_ordem: 1 } });
    await http(conta, 'get', '/pessoas').expect(403);
    const { body: navegacao } = await http(conta, 'get', '/autorizacao/navegacao').expect(200);
    expect(navegacao.permissoes.pessoas).not.toContain('view');
    await previa(admin, conta).expect(400);

    const { body: perfilRegente } = await http(admin, 'post', modelos).send({ ...entrada, nome: 'Perfil Regente',
      requisito: { tipo: 'oficio', oficio: 'PRESBITERO_REGENTE' }, acoes: ['FAMILIAS_CONSULTAR'] }).expect(201);
    const rotaRegente = modelos + '/' + perfilRegente.id + '/concessoes';
    const { body: regente } = await http(admin, 'post', rotaRegente + '/previa').send({ usuario_id: conta }).expect(201);
    await http(admin, 'post', rotaRegente).send({ usuario_id: conta, previa: regente.previa, fundamento }).expect(201);
    expect((await me(conta)).servicos_propostos).toContainEqual(expect.objectContaining({ acao: 'FAMILIAS_CONSULTAR', permite: true }));
    await db.mandato_oficial.update({ where: { id: mandato.id }, data: { termino_efetivo: new Date(hoje.getTime() - 86_400_000),
      motivo_encerramento: 'Término registrado em ata de ensaio' } });
    expect((await me(conta)).servicos_propostos).toContainEqual(expect.objectContaining({ acao: 'FAMILIAS_CONSULTAR', permite: false }));
  });
});
