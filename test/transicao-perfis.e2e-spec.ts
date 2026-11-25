import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { RotasServicosService } from '../src/autorizacao/rotas-servicos.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { usuarios_perfil } from '@prisma/client';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;

integration('Transição de perfis', () => {
  let app: INestApplication, db: PrismaService, admin: string, secretaria: string, comum: string;
  let igreja: string, outra: string;
  const cookies = new Map<string, string>();
  const novoCadastro = { nome_completo: 'Pessoa de ensaio', sexo: 'FEMININO', data_nascimento: '1990-04-20' };
  const fundamento = 'Homologação do serviço para esta igreja';

  function http(id: string, metodo: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string) {
    return request(app.getHttpServer())[metodo](path).set('Cookie', cookies.get(id)!)
      .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  }
  async function abrirSessao(id: string) {
    const u = await db.usuarios.findUniqueOrThrow({ where: { id } });
    cookies.set(id, 'provisao_session=' + await app.get(SessionService).create(id, u.igreja_id, u.auth_version));
  }
  async function conta(perfil: usuarios_perfil, igreja_id = igreja) {
    const p = await db.pessoas.create({ data: { igreja_id, ...novoCadastro, sexo: 'FEMININO', data_nascimento: new Date(novoCadastro.data_nascimento) } });
    const u = await db.usuarios.create({ data: { igreja_id, perfil, pessoa_id: p.id, nome_usuario: randomUUID(),
      email_login: randomUUID() + '@example.invalid', senha_hash: 'inutilizavel' } });
    await abrirSessao(u.id);
    return u.id;
  }
  const dar = (id: string, acao: string, fim: string | null = null) => http(admin, 'post', `/autorizacao/contas/${id}/atribuicoes`)
    .send({ acao, inicio: new Date(Date.now() - 1000).toISOString(), fim, fundamento });

  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public')
      throw new Error('Exige banco descartável E00.');
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.listen(0, '127.0.0.1');
    db = app.get(PrismaService);
    igreja = (await db.igreja.create({ data: { nome: 'Igreja da transição', mfa_obrigatorio: false } })).id;
    outra = (await db.igreja.create({ data: { nome: 'Outra igreja' } })).id;
    admin = await conta('ADMINISTRADOR');
    secretaria = await conta('SECRETARIO');
    comum = await conta('COMUM');
    await db.$executeRaw`SELECT instalar_estrutura_institucional(${igreja})`;
  });

  afterAll(async () => { await app?.close(); });

  it('fecha o acesso direto a todas as rotas econômicas e administrativas inventariadas sem serviço', async () => {
    const rotas = app.get(RotasServicosService).listar();
    expect(rotas.length).toBeGreaterThan(75);
    for (const r of rotas.filter(r => !r.contextual)) {
      const [verbo, path] = r.rota.split(' ');
      const endereco = path.replace(/:\w+/g, randomUUID());
      await http(comum, verbo.toLowerCase() as Parameters<typeof http>[1], endereco).expect(403);
    }
  });

  it('converte apenas os serviços revistos, invalida a sessão e conserva a conta institucional escolhida', async () => {
    const prefixo = '/autorizacao/contas/' + secretaria + '/conversao';
    const alvo = await db.usuarios.findUniqueOrThrow({ where: { id: secretaria } });
    await http(admin, 'patch', '/usuarios/' + secretaria).send({ perfil: 'COMUM' }).expect(400);
    const acoes = ['PESSOAS_CONSULTAR', 'PESSOAS_CADASTRAR'];
    const antigo = (await http(admin, 'post', prefixo + '/previa').send({ acoes }).expect(201)).body;
    const fim = new Date(Date.now() + 60_000).toISOString();
    await dar(secretaria, 'PESSOAS_CONSULTAR', fim).expect(201);
    await http(admin, 'post', prefixo).send({ acoes, fundamento, previa: antigo.previa }).expect(409);
    await db.usuarios.update({ where: { id: secretaria }, data: { conta_atuacao: true } });
    const contexto = await db.contexto_secretaria.findFirstOrThrow({ where: { igreja_id: igreja, orgao: { tipo_padrao: 'CONSELHO' } } });
    const outroContexto = await db.contexto_secretaria.findFirstOrThrow({ where: { igreja_id: igreja, orgao: { tipo_padrao: 'JUNTA' } } });
    const competencia = await db.competencia_secretaria.create({ data: {
      igreja_id: igreja, contexto_id: contexto.id, usuario_id: secretaria, pessoa_id: alvo.pessoa_id!, registrado_por_id: admin,
      inicio: new Date('2025-01-01'), autoridade: 'Conselho', evidencia: fundamento, pode_aprovar: true,
      pode_consultar_restritos: false, pode_deliberar: false, pode_instalar_mesa: false,
    } });
    const competencias = [competencia.id];
    const nova = (await http(admin, 'post', prefixo + '/previa').send({ acoes, competencias }).expect(201)).body;
    expect(nova.rotas).toContainEqual(expect.objectContaining({ rota: 'PATCH /pessoas/:id', antes: true, depois: false }));
    await http(admin, 'post', prefixo).send({ acoes, competencias, fundamento, previa: nova.previa }).expect(201);
    await http(secretaria, 'get', '/auth/profile').expect(401);
    await abrirSessao(secretaria);
    const visual = (await http(secretaria, 'get', '/autorizacao/navegacao').expect(200)).body.permissoes;
    expect(visual.pessoas.sort()).toEqual(['create', 'view']);
    expect(visual.lancamentos).toEqual([]);
    expect(visual.secretaria).toEqual(['view']);
    await http(secretaria, 'get', '/secretaria/contextos/' + contexto.id + '/resumo').expect(200);
    await http(secretaria, 'get', '/secretaria/contextos/' + outroContexto.id + '/resumo').expect(404);
    expect(await db.usuarios.findUnique({ where: { id: secretaria } })).toMatchObject({ perfil: 'COMUM', conta_atuacao: true,
      pessoa_id: alvo.pessoa_id, geracao_vinculo: alvo.geracao_vinculo + 1 });
    expect(await db.atribuicao_servico.findFirst({ where: { usuario_id: secretaria, acao: 'PESSOAS_CONSULTAR',
      geracao_vinculo: alvo.geracao_vinculo + 1 } })).toMatchObject({ fim: new Date(fim) });
    await http(secretaria, 'post', '/pessoas').send(novoCadastro).expect(201);
    await http(secretaria, 'get', '/pessoas').expect(200);
    await http(secretaria, 'patch', '/pessoas/' + alvo.pessoa_id).send({ nome_completo: 'Sem permissão' }).expect(403);
    await http(secretaria, 'get', '/lancamentos/balanco').expect(403);
  });

  it('consulta e aprova pedidos por serviços separados, criando conta comum', async () => {
    const pedido = await db.solicitacao_acesso.create({ data: { igreja_id: igreja, nome_usuario: 'Nova conta',
      email_login: randomUUID() + '@example.invalid', estado: 'EM_ANALISE' } });
    await dar(comum, 'ACESSO_CONSULTAR').expect(201);
    await http(comum, 'get', '/solicitacoes-acesso').expect(200);
    await http(comum, 'patch', '/solicitacoes-acesso/' + pedido.id + '/aprovar').expect(403);
    await dar(comum, 'ACESSO_ANALISAR').expect(201);
    await http(comum, 'patch', '/solicitacoes-acesso/' + pedido.id + '/aprovar').expect(200);
    const aprovado = await db.solicitacao_acesso.findUniqueOrThrow({ where: { id: pedido.id } });
    expect(await db.usuarios.findUnique({ where: { id: aprovado.usuario_id! } })).toMatchObject({ perfil: 'COMUM', pessoa_id: null });
  });

  it('isola a conta financeira e efetiva revogação na sessão aberta', async () => {
    const r = await dar(comum, 'LANCAMENTOS_REGISTRAR').expect(201);
    await dar(comum, 'BALANCO_CONSULTAR').expect(201);
    const local = await db.contas.create({ data: { igreja_id: igreja, descricao: 'Caixa local', tipo_conta: 'CAIXA' } });
    const externa = await db.contas.create({ data: { igreja_id: outra, descricao: 'Caixa externa', tipo_conta: 'CAIXA' } });
    const dados = { data_transacao: '2026-11-20', valor: 10, tipo_transacao: 'RECEITA' };
    await http(comum, 'post', '/lancamentos').send({ ...dados, conta_id: externa.id }).expect(400);
    await http(comum, 'post', '/lancamentos').send({ ...dados, conta_id: local.id }).expect(201);
    await http(comum, 'get', '/lancamentos/balanco?mes=11&ano=2026').expect(200);
    await http(comum, 'get', '/lancamentos').expect(403);
    await http(admin, 'post', '/autorizacao/atribuicoes/' + r.body.id + '/revogar').send({ fundamento }).expect(201);
    await http(comum, 'post', '/lancamentos').send({ ...dados, conta_id: local.id }).expect(403);
    expect(await db.lancamentos.count({ where: { igreja_id: igreja } })).toBe(1);
  });
  it('retira a Secretaria e a ficha de órgão da navegação ao terminar o cargo', async () => {
    const usuario = await conta('COMUM');
    const pessoa_id = (await db.usuarios.update({ where: { id: usuario }, data: { conta_atuacao: true } })).pessoa_id!;
    const inicio = new Date('2025-11-01');
    await db.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id, data_evento: inicio, tipo_evento: 'ADMISSAO',
      rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE' } });
    await db.pessoas.update({ where: { id: pessoa_id }, data: { sexo: 'MASCULINO' } });
    const orgao = await db.orgao_interno.findFirstOrThrow({ where: { igreja_id: igreja, tipo_padrao: 'CONSELHO' },
      include: { contexto_secretaria: true, cargos: true } });
    const oficial = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id, tipo: 'PRESBITERO_REGENTE' } });
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, tipo: 'ORDENACAO', data_efeito: inicio, ordem: 1,
      autoridade: 'Conselho', evidencia: fundamento } });
    await db.mandato_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, data_eleicao: inicio,
      data_posse: inicio, termino_previsto: new Date('2030-10-31'), autoridade: 'Assembleia', evidencia: fundamento, avaliacao_eleicao: {} } });
    const cargo = orgao.cargos.find(c => c.codigo === 'SECRETARIO')!;
    const ocupacao = await db.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgao.id, cargo_id: cargo.id, pessoa_id, inicio } });
    const navegar = () => http(usuario, 'get', '/autorizacao/navegacao').expect(200);
    const rota = '/secretaria/contextos/' + orgao.contexto_secretaria!.id + '/resumo';
    expect((await navegar()).body.permissoes).toMatchObject({ secretaria: ['view'], orgaos: ['view'], usuarios: [] });
    await http(usuario, 'get', rota).expect(200);
    const hoje = new Date(new Date().toISOString().slice(0, 10));
    await db.ocupacao_cargo.update({ where: { id: ocupacao.id }, data: { fim: hoje, fim_ordem: 1 } });
    expect((await navegar()).body.permissoes).toMatchObject({ secretaria: [], orgaos: [] });
    await http(usuario, 'get', rota).expect(404);
  });

  it('libera uma escrita na igreja escolhida e suspende sem restaurar a permissão por perfil', async () => {
    const acao = 'PESSOAS_CADASTRAR';
    const rota = '/autorizacao/liberacoes/' + acao;
    const legada = await conta('SECRETARIO');
    const operacional = await conta('COMUM');
    const externa = await conta('SECRETARIO', outra);
    const previa = async () => (await http(admin, 'get', rota + '/previa').expect(200)).body;
    const registrar = (id: string) => http(id, 'post', '/pessoas').send(novoCadastro);
    const atualizar = (estado: string, revisao: number, previa?: string) =>
      http(admin, 'patch', rota).send({ estado, revisao, previa, fundamento });

    await http(legada, 'get', rota + '/previa').expect(403);
    await registrar(legada).expect(201);
    const anterior = await previa();
    expect(anterior.diferencas).toContainEqual(expect.objectContaining({
      usuario_id: legada, rota: 'POST /pessoas', antes: true, depois: false,
    }));
    expect(anterior.diferencas.some(d => d.usuario_id === externa)).toBe(false);
    const atribuicao = (await dar(operacional, acao).expect(201)).body.id;
    await atualizar('ATRIBUICAO', 0, anterior.previa).expect(409);
    const atual = await previa();
    await atualizar('ATRIBUICAO', 0, atual.previa).expect(200);
    await registrar(legada).expect(403);
    await registrar(operacional).expect(201);
    await registrar(externa).expect(201);
    await http(legada, 'get', '/pessoas').expect(200);
    expect((await http(legada, 'get', '/autorizacao/navegacao').expect(200)).body.permissoes.pessoas).not.toContain('create');

    await atualizar('PAUSADO', 0).expect(409);
    await atualizar('PAUSADO', 1).expect(200);
    await registrar(operacional).expect(403);
    await http(legada, 'get', '/pessoas').expect(200);
    await http(admin, 'patch', '/autorizacao/liberacoes/PESSOAS_CONSULTAR')
      .send({ estado: 'PAUSADO', revisao: 0, fundamento }).expect(400);
    await http(admin, 'post', '/autorizacao/atribuicoes/' + atribuicao + '/revogar').send({ fundamento }).expect(201);
    const retomada = await previa();
    await atualizar('ATRIBUICAO', 2, retomada.previa).expect(200);
    await registrar(legada).expect(403);
    await registrar(operacional).expect(403);
    await expect(db.liberacao_servico.delete({ where: { igreja_id_acao: { igreja_id: igreja, acao } } })).rejects.toThrow();
    const trilha = await db.evento_autorizacao.findMany({ where: { igreja_id: igreja, acao: 'LIBERAR_SERVICO', recurso_id: acao } });
    expect(trilha).toHaveLength(3);
    expect(trilha.every(e => e.operador_id === admin && e.fundamento === fundamento)).toBe(true);
  });

  it('retira as duas rotas duplicadas de mandato e conserva a consulta após suspensão', async () => {
    const rota = '/autorizacao/liberacoes/MANDATOS_REGISTRAR';
    const legada = await conta('SECRETARIO');
    const conselho = await db.orgao_interno.findFirstOrThrow({ where: { igreja_id: igreja, tipo_padrao: 'CONSELHO' } });
    const { previa, revisao, diferencas } = (await http(admin, 'get', rota + '/previa').expect(200)).body;
    expect(new Set(diferencas.filter(d => d.usuario_id === legada).map(d => d.rota))).toEqual(new Set([
      'POST /oficiais/:id/mandatos', 'POST /oficiais/indicacoes/mandatos', 'PATCH /oficiais/mandatos/:id/encerrar',
    ]));
    await http(admin, 'patch', rota).send({ estado: 'ATRIBUICAO', revisao, previa, fundamento }).expect(200);
    for (const path of ['/oficiais/' + randomUUID() + '/mandatos', '/oficiais/indicacoes/mandatos'])
      await http(legada, 'post', path).send({}).expect(410);
    const usoLegado = await db.evento_autorizacao.findMany({ where: { igreja_id: igreja, operador_id: legada,
      acao: 'USO_ROTA_LEGADA', recurso_id: 'MANDATOS_REGISTRAR' } });
    expect(usoLegado.map(e => e.dados)).toEqual(expect.arrayContaining([
      { operacao: 'mandato', estado: 'ATRIBUICAO' }, { operacao: 'registrarMandatoPorIndicacao', estado: 'ATRIBUICAO' },
    ]));
    const ficha = '/orgaos/' + conselho.id + '/mandatos';
    await http(legada, 'post', ficha).send({}).expect(403);
    await http(legada, 'get', ficha).expect(200);
    expect((await http(legada, 'get', '/autorizacao/navegacao').expect(200)).body.mandatos_legados).toBe(false);
    await dar(legada, 'MANDATOS_REGISTRAR').expect(201);
    await http(legada, 'post', ficha).send({}).expect(400);
    await http(admin, 'patch', rota).send({ estado: 'PAUSADO', revisao: revisao + 1, fundamento }).expect(200);
    await http(legada, 'post', ficha).send({}).expect(403);
    await http(legada, 'patch', '/oficiais/mandatos/' + randomUUID() + '/encerrar').send({
      data_efeito: '2026-11-25', motivo: fundamento, autoridade: fundamento, evidencia: fundamento,
    }).expect(403);
    expect((await http(legada, 'get', ficha).expect(200)).body.pode_registrar).toBe(false);
  });

  it('migra cadastros financeiros com atribuição e mantém o acervo com sua concessão específica', async () => {
    const legada = await conta('ADMINISTRADOR');
    const operacional = await conta('COMUM');
    const ativar = async (acao: string) => {
      const rota = '/autorizacao/liberacoes/' + acao;
      const { previa, revisao } = (await http(admin, 'get', rota + '/previa').expect(200)).body;
      await http(admin, 'patch', rota).send({ estado: 'ATRIBUICAO', previa, revisao, fundamento }).expect(200);
    };
    const banco = { descricao: 'Caixa operacional', tipo_conta: 'CAIXA', saldo_inicial: 0 };
    await http(legada, 'post', '/contas').send(banco).expect(201);
    await dar(operacional, 'CONTAS_CADASTRAR').expect(201);
    await ativar('CONTAS_CADASTRAR');
    await http(legada, 'post', '/contas').send(banco).expect(403);
    await http(operacional, 'post', '/contas').send(banco).expect(201);
    await http(legada, 'get', '/contas').expect(200);

    const pessoa = (await db.usuarios.findUniqueOrThrow({ where: { id: legada } })).pessoa_id!;
    const oficial = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    const registro = { tipo: 'ELEICAO', data_evento: '2019-12-01', data_descricao: null,
      situacao_documental: 'EXTERNO_CONFERIDO', referencia_externa: 'Livro do ensaio', autoridade: 'Conselho',
      idempotencia: randomUUID() };
    await dar(operacional, 'HISTORICO_OFICIAIS_REGISTRAR').expect(201);
    await dar(operacional, 'HISTORICO_OFICIAIS_CONSULTAR').expect(201);
    await ativar('HISTORICO_OFICIAIS_REGISTRAR');
    await ativar('HISTORICO_OFICIAIS_CONSULTAR');
    const rota = '/oficiais/' + oficial.id + '/acervo-historico';
    await http(legada, 'post', rota).send(registro).expect(403);
    const { id } = (await http(operacional, 'post', rota).send(registro).expect(201)).body;
    await http(operacional, 'get', rota).expect(200);
    const detalhe = '/oficiais/acervo-historico/' + id + '/detalhe';
    await http(operacional, 'get', detalhe).expect(403);
    await http(admin, 'post', '/oficiais/acessos-sensiveis')
      .send({ usuario_id: operacional, pode_consultar: true, pode_registrar: false, fundamento }).expect(201);
    await http(operacional, 'get', detalhe).expect(200);
    await http(operacional, 'get', '/oficiais/pessoas/' + pessoa + '/correcoes-data').expect(403);
  });

  it('migra a análise de solicitações e preserva a consulta e o cadastro técnico', async () => {
    const responsavel = await conta('GESTOR');
    const outro = await conta('GESTOR');
    const rota = '/autorizacao/liberacoes/ACESSO_ANALISAR';
    const pedido = await db.solicitacao_acesso.create({ data: { igreja_id: igreja, nome_usuario: 'Candidato',
      email_login: randomUUID() + '@example.invalid', estado: 'EM_ANALISE' } });
    await http(responsavel, 'get', '/solicitacoes-acesso').expect(403);
    await dar(responsavel, 'ACESSO_ANALISAR').expect(201);
    const { previa, revisao, diferencas } = (await http(admin, 'get', rota + '/previa').expect(200)).body;
    expect(diferencas).toContainEqual(expect.objectContaining({ usuario_id: responsavel, antes: false, depois: true }));
    expect(diferencas.some(d => d.usuario_id === outro)).toBe(false);
    await http(admin, 'patch', rota).send({ estado: 'ATRIBUICAO', revisao, previa, fundamento }).expect(200);
    const caminho = '/solicitacoes-acesso/' + pedido.id + '/rejeitar';
    await http(admin, 'patch', caminho).expect(403);
    await http(admin, 'get', '/solicitacoes-acesso').expect(200);
    await http(responsavel, 'get', '/solicitacoes-acesso').expect(403);
    await http(responsavel, 'patch', caminho).expect(200);
    expect((await http(responsavel, 'get', '/autorizacao/navegacao').expect(200)).body.permissoes['solicitacoes-acesso']).toEqual(['edit']);
  });
});
