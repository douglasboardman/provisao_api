import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as request from 'supertest';
import { usuarios_perfil } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
import { RotasServicosService } from '../src/autorizacao/rotas-servicos.service';

const integration = process.env.PERFIS_ATUAIS_INTEGRATION === '1' ? describe : describe.skip;
integration('Contas atuais, atribuições e cargos institucionais', () => {
  let app: INestApplication, db: PrismaService, igreja: string, outra: string;
  let admin: string, comum: string, auditor: string, secretaria: string, ocupacao: string;
  let conselho: string, assembleia: string, junta: string;
  const cookies = new Map<string, string>();
  const http = (id: string, method: string, path: string) => request(app.getHttpServer())[method](path)
    .set('Cookie', cookies.get(id)!).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  async function conta(perfil: usuarios_perfil, church = igreja, atuacao = false) {
    const pessoa = await db.pessoas.create({ data: { igreja_id: church, nome_completo: 'Pessoa de ensaio', sexo: 'MASCULINO', data_nascimento: new Date('1980-01-01') } });
    const u = await db.usuarios.create({ data: { igreja_id: church, perfil, pessoa_id: pessoa.id, conta_atuacao: atuacao,
      nome_usuario: 'Conta de ensaio', email_login: randomUUID() + '@example.invalid', senha_hash: 'inutilizavel' } });
    cookies.set(u.id, 'provisao_session=' + await app.get(SessionService).create(u.id, church, u.auth_version));
    return u.id;
  }
  async function conceder(id: string, acao: string, fim?: Date) {
    const u = await db.usuarios.findUniqueOrThrow({ where: { id } });
    return db.atribuicao_servico.create({ data: { igreja_id: u.igreja_id, usuario_id: id, pessoa_id: u.pessoa_id!,
      geracao_vinculo: u.geracao_vinculo, acao, inicio: new Date('2020-01-01'), fim } });
  }
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public')
      throw new Error('Use somente o PostgreSQL descartável de teste.');
    Object.assign(process.env, { FEATURE_SECRETARIA: 'true', FEATURE_GOVERNANCA: 'true', FEATURE_ORGAOS: 'true', FEATURE_ORGAOS_GESTAO: 'true', FRONTEND_URL: 'http://localhost:3001' });
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init(); db = app.get(PrismaService);
    igreja = (await db.igreja.create({ data: { nome: 'Ensaio de contas atuais', mfa_obrigatorio: false } })).id;
    outra = (await db.igreja.create({ data: { nome: 'Outra igreja', mfa_obrigatorio: false } })).id;
    admin = await conta('ADMINISTRADOR'); comum = await conta('COMUM'); auditor = await conta('AUDITOR'); secretaria = await conta('COMUM', igreja, true);
    await db.$executeRaw`SELECT instalar_estrutura_institucional(${igreja})`;
    const contextos = await db.contexto_secretaria.findMany({ where: { igreja_id: igreja }, include: { orgao: true } });
    conselho = contextos.find(c => c.orgao.tipo === 'CONSELHO')!.id;
    assembleia = contextos.find(c => c.orgao.tipo === 'ASSEMBLEIA_GERAL')!.id;
    junta = contextos.find(c => c.orgao.tipo === 'JUNTA')!.id;
    const u = await db.usuarios.findUniqueOrThrow({ where: { id: secretaria } }), dia = new Date('2026-01-01');
    const of = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: u.pessoa_id!, tipo: 'PRESBITERO_REGENTE' } });
    await db.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: u.pessoa_id!, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: dia, referencia_documental: 'Registro de teste' } });
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: of.id, tipo: 'ORDENACAO', data_efeito: dia, ordem: 1, autoridade: 'Concílio', evidencia: 'Registro' } });
    await db.mandato_oficial.create({ data: { igreja_id: igreja, oficial_id: of.id, data_eleicao: dia, data_posse: dia, termino_previsto: new Date('2031-01-01'), autoridade: 'Assembleia', evidencia: 'Registro', avaliacao_eleicao: {} } });
    const orgao_id = contextos.find(c => c.id === conselho)!.orgao_id;
    const cargo = await db.cargo_orgao.findFirstOrThrow({ where: { igreja_id: igreja, orgao_id, funcao: 'SECRETARIO' } });
    ocupacao = (await db.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id, cargo_id: cargo.id, pessoa_id: u.pessoa_id!, inicio: dia, termino_previsto: new Date('2031-01-01') } })).id;
  });
  afterAll(async () => { await app?.close(); });

  it('só admite os três tipos de conta atuais, inclusive no banco', async () => {
    expect(Object.values(usuarios_perfil).sort()).toEqual(['ADMINISTRADOR', 'AUDITOR', 'COMUM']);
    const tipos = await db.$queryRaw<{tipo:string}[]>`SELECT unnest(enum_range(NULL::usuarios_perfil))::text AS tipo`;
    expect(tipos.map(t => t.tipo).sort()).toEqual(['ADMINISTRADOR', 'AUDITOR', 'COMUM']);
    for (const perfil of ['GESTOR','SECRETARIO','TESOUREIRO','OPERADOR'])
      await http(admin, 'patch', '/usuarios/' + comum).send({ perfil }).expect(400);
    await http(admin, 'post', `/autorizacao/contas/${comum}/conversao`).send({}).expect(404);
  });
  it('fecha todas as rotas de serviço inventariadas para uma conta sem atribuição', async () => {
    const rotas = app.get(RotasServicosService).listar().filter(r => !r.contextual && !r.retirada);
    expect(rotas.length).toBeGreaterThan(90);
    for (const r of rotas) {
      const [metodo, path] = r.rota.split(' ');
      const res = await http(comum, metodo.toLowerCase(), path.replace(/:\w+/g, randomUUID()));
      expect({ rota: r.rota, status: res.status }).toEqual({ rota: r.rota, status: 403 });
    }
    const nav = (await http(comum, 'get', '/autorizacao/navegacao').expect(200)).body;
    expect(nav.permissoes.pessoas).toEqual([]);
  });
  it('permite consulta e cadastro somente pelos serviços concedidos, sem atravessar igrejas', async () => {
    await conceder(comum, 'PESSOAS_CONSULTAR'); await conceder(comum, 'PESSOAS_CADASTRAR');
    await http(comum, 'get', '/pessoas').expect(200);
    await http(comum, 'post', '/pessoas').send({ nome_completo: 'Nova pessoa', sexo: 'FEMININO', data_nascimento: '1990-01-01' }).expect(201);
    const externa = await db.pessoas.create({ data: { igreja_id: outra, nome_completo:'Externa', sexo:'FEMININO', data_nascimento:new Date('1990-01-01') } });
    await http(comum, 'get', '/pessoas/' + externa.id).expect(404);
    await http(comum, 'patch', '/pessoas/' + externa.id).send({ nome_completo: 'Não pode' }).expect(403);
    const nav = (await http(comum, 'get', '/autorizacao/navegacao')).body;
    expect(nav.permissoes.pessoas).toEqual(['view','create']);
  });
  it('revogação, prazo e suspensão têm efeito imediato na API e na navegação', async () => {
    await db.atribuicao_servico.updateMany({ where:{usuario_id:comum,acao:'PESSOAS_CONSULTAR'},data:{revogado_em:new Date()} });
    await http(comum,'get','/pessoas').expect(403);
    await conceder(comum,'OFICIAIS_CONSULTAR',new Date('2021-01-01'));
    await http(comum,'get','/oficiais').expect(403);
    await db.liberacao_servico.create({data:{igreja_id:igreja,acao:'PESSOAS_CADASTRAR',estado:'PAUSADO',revisao:1}});
    await http(comum,'post','/pessoas').send({}).expect(403);
    const nav=(await http(comum,'get','/autorizacao/navegacao')).body;
    expect(nav.permissoes.pessoas).toEqual([]);
  });
  it('auditor consulta por atribuição e não recebe permissão de escrita', async () => {
    await conceder(auditor,'PESSOAS_CONSULTAR'); await conceder(auditor,'PESSOAS_EDITAR');
    await http(auditor,'get','/pessoas').expect(200);
    await http(auditor,'patch','/pessoas/'+randomUUID()).send({}).expect(403);
    await http(auditor,'post','/orgaos/gestao/oficiais').send({}).expect(403);
  });
  it('reconhece secretaria em exercício no Conselho e Assembleia, sem estender à Junta', async () => {
    const cs=(await http(secretaria,'get','/secretaria/contextos').expect(200)).body;
    expect(cs.find(c=>c.id===conselho)).toMatchObject({pode_editar_ata_legada:true,pode_gerir_modelos:true});
    expect(cs.find(c=>c.id===assembleia).pode_editar_ata_legada).toBe(true);
    expect(cs.find(c=>c.id===junta)?.pode_editar_ata_legada??false).toBe(false);
    await http(secretaria,'post','/secretaria/campos').send({idempotencia:randomUUID(),nome:'Campo do secretário',tipo:'texto',multiplo:false,origem:'manual'}).expect(201);
    await http(comum,'post','/secretaria/campos').send({idempotencia:randomUUID(),nome:'Campo indevido',tipo:'texto',multiplo:false,origem:'manual'}).expect(403);
    const nav=(await http(secretaria,'get','/autorizacao/navegacao')).body;
    expect(nav.permissoes['campos-secretaria']).toContain('edit');
  });
  it('consulta notificações com serviço vigente e respeita a revogação', async () => {
    const grant=await conceder(secretaria,'OFICIAIS_CONSULTAR');
    await http(secretaria,'get','/oficiais/notificacoes').expect(200);
    await http(secretaria,'get','/oficiais/meu-acesso-sensivel').expect(200);
    await http(secretaria,'post','/oficiais').send({}).expect(403);
    await db.atribuicao_servico.update({where:{id:grant.id},data:{revogado_em:new Date()}});
    await http(secretaria,'get','/oficiais/notificacoes').expect(403);
  });
  it('permite configurar estrutura apenas com a atribuição própria e sem liberar administração de contas', async () => {
    await conceder(comum,'ORGAOS_CONFIGURAR');
    const orgao = await db.contexto_secretaria.findUniqueOrThrow({where:{id:conselho}});
    await http(comum,'patch',`/orgaos/gestao/${orgao.orgao_id}/cadastro`).send({nome:'Conselho de ensaio',sigla:null,finalidade:'Serviço',autoridade:'Conselho',evidencia:'Registro',idempotencia:randomUUID()}).expect(200);
    await http(comum,'get','/orgaos').expect(200);
    await http(comum,'post','/usuarios').send({}).expect(403);
    await http(comum,'post','/oficiais/configuracao-alertas').send({}).expect(403);
  });
  it('mantém a gestão de unidades limitada à competência vigente', async () => {
    const usuario = await conta('COMUM');
    const u = await db.usuarios.findUniqueOrThrow({ where: { id: usuario } });
    const unidade = await db.orgao_interno.create({ data: { igreja_id: igreja, tipo: 'UNIDADE_MINISTERIAL',
      nome: 'Unidade de ensaio', constituicao: 'DESIGNACAO', finalidade: 'Ensaio', gestao_presidencial: false, data_criacao: new Date('2020-01-01'), criador_id: admin, instituidor_id: u.pessoa_id, evidencia_instituicao: 'Registro' } });
    const competencia = await db.competencia_unidades.create({ data: { igreja_id: igreja, usuario_id: usuario,
      pessoa_id: u.pessoa_id!, inicio: new Date('2020-01-01'), autoridade: 'Conselho', evidencia: 'Registro', registrado_por: admin } });
    const lista = (await http(usuario, 'get', '/orgaos').expect(200)).body;
    expect(lista.itens.map(o => o.id)).toContain(unidade.id);
    expect(lista.itens.map(o => o.id)).not.toContain((await db.contexto_secretaria.findUniqueOrThrow({where:{id:conselho}})).orgao_id);
    await http(usuario, 'get', '/orgaos/' + unidade.id).query({ data: '2026-11-27' }).expect(200);
    await db.competencia_unidades.update({ where: { id: competencia.id }, data: { fim: new Date('2021-01-01') } });
    expect((await http(usuario, 'get', '/orgaos').expect(200)).body.itens).toEqual([]);
    await http(usuario, 'get', '/orgaos/' + unidade.id).query({ data: '2026-11-27' }).expect(404);
  });
  it('revalida o cargo antes de repetir um comando de modelo já executado', async () => {
    const dados = { idempotencia: randomUUID(), contexto_id: conselho, nome: 'Modelo de ensaio',
      tipo: 'OUTRO', finalidade: 'CARTA', publicar: false,
      configuracao: { perfil: 'CARTA', contexto: 'ORGAO', tipos_orgao: ['CONSELHO'], constituicoes: ['OFICIAL'],
        motivador: 'OPCIONAL', resolucoes: 'OPCIONAL', registro_livro: false, campos_obrigatorios: [],
        papeis_obrigatorios: [], cargos_obrigatorios: [] } };
    await http(secretaria, 'post', '/secretaria/modelos').send(dados).expect(201);
    await http(secretaria, 'post', '/secretaria/modelos').send(dados).expect(201);
    await db.ocupacao_cargo.update({ where: { id: ocupacao }, data: { fim: new Date('2026-01-02'), fim_ordem: 1 } });
    await http(secretaria, 'post', '/secretaria/modelos').send(dados).expect(r => expect([403,404]).toContain(r.status));
  });
  it('término do cargo retira também o acesso aos campos e a edição contextual', async () => {
    await db.ocupacao_cargo.update({where:{id:ocupacao},data:{fim:new Date('2026-01-02'),fim_ordem:1}});
    const cs=(await http(secretaria,'get','/secretaria/contextos').expect(200)).body;
    expect(cs.find(c=>c.id===conselho)?.pode_editar_ata_legada??false).toBe(false);
    await http(secretaria,'post','/secretaria/campos').send({idempotencia:randomUUID(),nome:'Campo após cargo',tipo:'texto',multiplo:false,origem:'manual'}).expect(403);
  });
});
