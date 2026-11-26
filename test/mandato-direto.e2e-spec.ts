import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';

const ensaio = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
ensaio('Ficha e mandato por ata', () => {
  const igreja = randomUUID(), visitante = randomUUID(), gestor = randomUUID();
  const datas = (s: string) => new Date(s + 'T00:00:00Z');
  let app: INestApplication, db: PrismaService, cookie: string, estrangeiro: string, conselho: string, junta: string, ag: string, con: string, candidato: string, concessao: string;
  const pessoa = async (igreja_id: string, nome: string) => {
    const p = await db.pessoas.create({ data: { igreja_id, nome_completo: nome, data_nascimento: datas('1975-06-01'), sexo: 'MASCULINO' } });
    await db.eventos_membresia.create({ data: { igreja_id, pessoa_id: p.id, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: datas('1999-02-01') } });
    return p.id;
  };
  async function ata(contexto_id: string, data: string) {
    const modelo = await db.modelo_documento.create({ data: { igreja_id: igreja, contexto_id, nome: 'Ata sintética' } });
    const m = await db.modelo_documento_versao.create({ data: { igreja_id: igreja, contexto_id, modelo_id: modelo.id, numero: 1, tipo: 'ATA', finalidade: 'Teste', configuracao: {} } });
    const d = await db.documento.create({ data: { igreja_id: igreja, contexto_id, tipo: 'ATA', estado: 'APROVADO', perfil: 'TESTE' } });
    return (await db.documento_versao.create({ data: { igreja_id: igreja, contexto_id, documento_id: d.id, numero: 1,
      modelo_versao_id: m.id, assunto: 'Eleição ou posse', data_documento: datas(data), conteudo: {} } })).id;
  }
  async function usuario(id: string, igreja_id: string, perfil: 'ADMINISTRADOR' | 'GESTOR' = 'GESTOR') {
    const pessoa_id = await pessoa(igreja_id, 'Operador');
    const u = await db.usuarios.create({ data: { id, igreja_id, pessoa_id, nome_usuario: 'Operador', perfil, email_login: id + '@example.invalid', senha_hash: 'teste' } });
    return { cookie: 'provisao_session=' + await app.get(SessionService).create(id, igreja_id, u.auth_version), pessoa_id };
  }
  const http = (metodo: 'get' | 'post' | 'patch', path: string, c = cookie) => request(app.getHttpServer())[metodo](path)
    .set('Cookie', c).set('Origin','http://localhost:3001').set('X-Provisao-Request','1');
  const membros = async (id: string, dia: string) => ((await http('get', '/orgaos/' + id).query({ data: dia }).expect(200)).body.composicao?.membros ?? []).map(m => m.pessoa_id);
  const novo = async (p: string, eleicao: string, posse: string) => ({
    pessoa_id: p, ata_eleicao: await ata(ag, eleicao), ata_posse: await ata(con, posse),
    idempotencia: randomUUID(),
  });
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige o banco descartável de ensaio.');
    for (const k of ['GOVERNANCA','SECRETARIA','ORGAOS','ORGAOS_GESTAO']) process.env['FEATURE_' + k] = 'true';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init(); db = app.get(PrismaService);
    await db.igreja.createMany({ data: [igreja, visitante].map(id => ({ id, nome: 'Igreja sintética' })) });
    await db.$executeRaw`SELECT instalar_estrutura_institucional(${igreja})`;
    const orgaos = await db.orgao_interno.findMany({ where: { igreja_id: igreja }, include: { contexto_secretaria: true } });
    const c = orgaos.find(o => o.tipo === 'CONSELHO')!;
    conselho = c.id; con = c.contexto_secretaria!.id; junta = orgaos.find(o => o.tipo === 'JUNTA')!.id; ag = orgaos.find(o => o.tipo === 'ASSEMBLEIA_GERAL')!.contexto_secretaria!.id;
    candidato = await pessoa(igreja, 'Regente');
    const operador = await usuario(gestor, igreja); cookie = operador.cookie; estrangeiro = (await usuario(randomUUID(), visitante)).cookie;
    concessao = (await db.atribuicao_servico.create({ data: { igreja_id: igreja, usuario_id: gestor, pessoa_id: operador.pessoa_id,
      geracao_vinculo: 0, acao: 'MANDATOS_REGISTRAR', inicio: datas('2000-01-01') } })).id;
  });
  afterAll(async () => { await app?.close(); });

  it('registra ordenação e posse sem indicação, reaproveita o ofício e apura exercício por data', async () => {
    const path = '/orgaos/' + conselho + '/mandatos', original = await novo(candidato, '2015-01-01', '2015-02-01');
    await http('post', path + '/previa').send(original).expect(400);
    const dados = { ...original, ordenacao: { data: '2015-02-01', autoridade: 'Conselho' } };
    await http('post', path + '/previa').send({ ...dados, data_posse: '2015-02-02' }).expect(400)
      .expect(r => expect(r.body.message).toMatch(/data da posse deve ser a da ata/));
    await http('post', path + '/previa').send({ ...dados, ata_posse: await ata(con, '2014-12-31') }).expect(400)
      .expect(r => expect(r.body.message).toMatch(/ata da posse antecede a eleição/));
    const previa = (await http('post', path + '/previa').send(dados).expect(201)).body;
    expect(previa).toMatchObject({ reeleicao: false, data_eleicao: '2015-01-01', data_posse: '2015-02-01',
      termino_previsto: '2020-01-31', transcricao_historica: true });
    expect(await db.oficial.count({ where: { pessoa_id: candidato } })).toBe(0);
    const confirmar = () => http('post', path).send({ ...dados, previa: previa.previa }).expect(201);
    const [a,b] = await Promise.all([confirmar(), confirmar()]);
    expect(a.body).toEqual(b.body);
    expect(await db.mandato_oficial.findUnique({ where: { id: a.body.id }, include: { referencias_ata: true } })).toMatchObject({
      indicacao_id: null, orgao_id: conselho, data_eleicao: datas('2015-01-01'), data_posse: datas('2015-02-01'),
      referencias_ata: expect.arrayContaining([
        expect.objectContaining({ ato: 'ELEICAO', versao_id: dados.ata_eleicao, justificativa: 'Ata da eleição' }),
        expect.objectContaining({ ato: 'POSSE', versao_id: dados.ata_posse, justificativa: 'Ata da posse' }),
      ]) });
    expect(await membros(conselho,'2015-01-31')).not.toContain(candidato);
    expect(await membros(conselho,'2015-02-01')).toEqual([candidato]);
    const suspenso = await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: a.body.oficial_id, tipo: 'SUSPENSAO', data_efeito: datas('2017-01-01'), ordem: 1, autoridade: 'Teste', evidencia: 'Reservada' } });
    expect(await membros(conselho,'2017-01-01')).not.toContain(candidato);
    const ficha = await http('get','/orgaos/' + conselho).query({ data: '2017-01-01', inativos: '1' }).expect(200);
    expect(ficha.body.fora_da_composicao).toEqual([{ id: candidato, nome_completo: 'Regente' }]);
    expect(JSON.stringify(ficha.body)).not.toContain('Reservada');
    const refs = (await http('get','/secretaria/referencias-ata/MANDATO/' + a.body.id + '/ELEICAO').expect(200)).body.itens;
    expect(refs[0].ata).toMatchObject({ contexto_id: ag, versao_id: dados.ata_eleicao });
    const renovacao = await novo(candidato,'2019-11-01','2020-02-01');
    await http('post', path + '/previa').send(renovacao).expect(400);
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: a.body.oficial_id, tipo: 'RESTAURACAO', data_efeito: datas('2019-12-01'), ordem: 1, evento_restaurado_id: suspenso.id, autoridade: 'Teste', evidencia: 'Teste' } });
    const previa2 = (await http('post', path + '/previa').send(renovacao).expect(201)).body;
    expect(previa2.reeleicao).toBe(true);
    const segundo = (await http('post', path).send({ ...renovacao, previa: previa2.previa }).expect(201)).body;
    expect(segundo.oficial_id).toBe(a.body.oficial_id);
    expect(await membros(conselho,'2020-02-01')).toEqual([candidato]);
    const rotaFim = '/oficiais/mandatos/' + segundo.id + '/encerrar';
    const fim = { data_efeito: '2021-05-10', motivo: 'Encerramento' };
    await http('patch', rotaFim).send({ ...fim, autoridade: 'Conselho', evidencia: 'Ata' }).expect(400);
    await http('patch', rotaFim).send({ ...fim, ata_encerramento: renovacao.ata_eleicao }).expect(404);
    const ataEncerramento = await ata(con, '2021-05-15');
    await http('patch', rotaFim).send({ ...fim, ata_encerramento: ataEncerramento }).expect(200);
    const { body: referencias } = await http('get', '/secretaria/referencias-ata/MANDATO/' + segundo.id + '/ENCERRAMENTO').expect(200);
    expect(referencias.itens[0].ata.versao_id).toBe(ataEncerramento);
    expect(await membros(conselho,'2021-05-10')).toEqual([candidato]);
    expect(await membros(conselho,'2021-05-11')).toEqual([]);
  });

  it('consulta o docente a partir do vínculo pastoral e conserva indicações sem ofício constituído', async () => {
    const pastor = await pessoa(igreja, 'Docente'), indicado = await pessoa(igreja, 'Indicado');
    const of = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: pastor, tipo: 'PRESBITERO_DOCENTE' } });
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: of.id, tipo: 'ORDENACAO', data_efeito: datas('2010-01-01'), ordem: 1, autoridade: 'Presbitério', evidencia: 'Ato' } });
    await db.vinculo_pastoral.create({ data: { igreja_id: igreja, oficial_id: of.id, data_inicio: datas('2018-05-01'), data_fim: datas('2019-03-15'),
      motivo_fim: 'Término', autoridade_fim: 'Presbitério', evidencia_fim: 'Ato', ato: 'Designação', concilio: 'Presbitério', evidencia: 'Livro', modalidade: 'Pastor', exercicio_institucional: true } });
    expect(await membros(conselho,'2018-05-01')).toContain(pastor);
    expect(await membros(conselho,'2019-03-15')).toContain(pastor);
    expect(await membros(conselho,'2019-03-16')).not.toContain(pastor);
    const docentes = await http('get','/orgaos/' + conselho + '/docentes').expect(200);
    expect(docentes.body.itens[0].vinculos_pastorais).toHaveLength(1);
    const anterior = await ata(con,'2011-03-01');
    await db.indicacao_eleicao_oficial.create({ data: { igreja_id: igreja, pessoa_id: indicado, oficio: 'DIACONO', ata_conselho_versao_id: anterior,
      data_assembleia: datas('2011-04-01'), registrado_por_id: gestor } });
    const h = await http('get','/oficiais/indicacoes/historico').expect(200);
    expect(h.body.itens[0]).toMatchObject({ mandato: null, pessoa: { nome_completo: 'Indicado' }, ata_conselho: { id: anterior, contexto_id: con } });
    await db.documento.updateMany({ where: { versoes: { some: { id: anterior } } }, data: { restrito: true } });
    expect((await http('get','/oficiais/indicacoes/historico').expect(200)).body.itens).toHaveLength(0);
  });

  it('vincula indicação histórica elegível preservando as duas atas exigidas', async () => {
    const p = await pessoa(igreja, 'Diácono indicado');
    const entrada = await novo(p, '2011-04-01', '2011-05-01');
    const i = await db.indicacao_eleicao_oficial.create({ data: {
      igreja_id: igreja, pessoa_id: p, oficio: 'DIACONO', data_assembleia: datas('2011-04-01'),
      ata_conselho_versao_id: await ata(con, '2011-03-01'), registrado_por_id: gestor,
    } });
    const rota = '/orgaos/' + junta + '/mandatos';
    const filtros = { pessoa: p, ata: entrada.ata_eleicao };
    await http('get', rota + '/indicacoes').query(filtros).expect(200)
      .expect(r => expect(r.body).toMatchObject([{ id: i.id }]));
    await http('get', '/orgaos/' + conselho + '/mandatos/indicacoes').query(filtros).expect(200, []);
    await http('get', rota + '/indicacoes', estrangeiro).query(filtros).expect(403);
    const dados = { ...entrada, indicacao_id: i.id, ordenacao: { data: '2011-05-01', autoridade: 'Conselho', evidencia: 'Livro I' } };
    await http('post', rota + '/previa').send({ ...dados, indicacao_id: randomUUID() }).expect(404);
    const { body: previa } = await http('post', rota + '/previa').send(dados).expect(201);
    expect(previa).toMatchObject({ indicacao_id: i.id, assunto_indicacao: 'Eleição ou posse' });
    const { body: mandato } = await http('post', rota).send({ ...dados, previa: previa.previa }).expect(201);
    await http('post', rota).send({ ...dados, previa: previa.previa }).expect(201, mandato);
    const salvo = await db.mandato_oficial.findUniqueOrThrow({ where: { id: mandato.id }, include: { referencias_ata: true } });
    expect(salvo.indicacao_id).toBe(i.id);
    expect(salvo.referencias_ata.map(a => a.ato).sort()).toEqual(['ELEICAO', 'POSSE']);
    await http('get', rota + '/indicacoes').query(filtros).expect(200, []);
  });

  it('aplica contexto, sigilo, escopo da igreja e revogação até no reenvio e usa a data bissexta da ata de posse na Junta', async () => {
    const p = await pessoa(igreja, 'Diácono'), path = '/orgaos/' + junta + '/mandatos';
    const dados = { ...await novo(p,'2020-02-01','2024-02-29'), ordenacao: { data: '2020-02-01', autoridade: 'Conselho', evidencia: 'Ato documentado' } };
    await http('post', path + '/previa').send({ ...dados, ata_posse: dados.ata_eleicao }).expect(404);
    await http('get', path, estrangeiro).expect(404);
    await http('post', path + '/previa', estrangeiro).send(dados).expect(403);
    const doc = await db.documento_versao.findUniqueOrThrow({ where: { id: dados.ata_eleicao } });
    await db.documento.update({ where: { id: doc.documento_id }, data: { restrito: true } });
    await http('post', path + '/previa').send(dados).expect(404);
    await db.documento.update({ where: { id: doc.documento_id }, data: { restrito: false } });
    const previa = (await http('post', path + '/previa').send(dados).expect(201)).body;
    expect(previa).toMatchObject({ data_posse: '2024-02-29', termino_previsto: '2029-02-27' });
    const confirmar = { ...dados, previa: previa.previa };
    await http('post', path).send(confirmar).expect(201);
    expect(await membros(junta,'2024-02-28')).toEqual([]);
    expect(await membros(junta,'2024-02-29')).toContain(p);
    await db.atribuicao_servico.update({ where: { id: concessao }, data: { revogado_em: new Date() } });
    await http('post', path).send(confirmar).expect(403);
    expect((await http('get', path).expect(200)).body.pode_registrar).toBe(false);
  });

  it('permite ao administrador identificado registrar o próprio mandato documentado sem concessão', async () => {
    const adminId = randomUUID();
    const admin = await usuario(adminId, igreja, 'ADMINISTRADOR');
    const adminOutraIgreja = await usuario(randomUUID(), visitante, 'ADMINISTRADOR');
    const path = '/orgaos/' + conselho + '/mandatos';
    const dados = { ...await novo(admin.pessoa_id, '2022-02-01', '2022-03-01'),
      ordenacao: { data: '2022-03-01', autoridade: 'Conselho', evidencia: 'Ata da ordenação' } };
    const consulta = async () => (await http('get', path, admin.cookie).expect(200)).body;
    const conferir = (sessao: string) => http('post', path + '/previa', sessao).send(dados);
    expect((await consulta()).pode_registrar).toBe(true);
    await http('get', '/oficiais/indicacoes/selecao-atas', admin.cookie).query({ tipo: 'ASSEMBLEIA' }).expect(200)
      .expect(r => expect(r.body.itens.some(v => v.versao_id === dados.ata_eleicao)).toBe(true));
    await http('get', path + '/indicacoes', admin.cookie).query({ pessoa: admin.pessoa_id, ata: dados.ata_eleicao }).expect(200);
    await conferir(adminOutraIgreja.cookie).expect(404);
    const { body: previa } = await conferir(admin.cookie).expect(201);
    const escopo = { igreja_id: igreja, acao: 'MANDATOS_REGISTRAR' };
    await db.liberacao_servico.create({ data: { ...escopo, estado: 'PAUSADO', revisao: 1 } });
    expect((await consulta()).pode_registrar).toBe(false);
    await conferir(admin.cookie).expect(403);
    await db.liberacao_servico.update({ where: { igreja_id_acao: escopo }, data: { estado: 'ATRIBUICAO', revisao: 2 } });
    await db.usuarios.update({ where: { id: adminId }, data: { pessoa_id: null } });
    expect((await consulta()).pode_registrar).toBe(false);
    await conferir(admin.cookie).expect(403);
    await db.usuarios.update({ where: { id: adminId }, data: { pessoa_id: admin.pessoa_id } });
    const { body: mandato } = await http('post', path, admin.cookie).send({ ...dados, previa: previa.previa }).expect(201);
    expect(await db.evento_autorizacao.findFirstOrThrow({ where: { igreja_id: igreja, recurso_id: mandato.id, acao: 'MANDATO_REGISTRADO' } }))
      .toMatchObject({ operador_id: adminId, pessoa_id: admin.pessoa_id, dados: { atribuicao_id: null, origem_autorizacao: 'PERFIL_ADMINISTRADOR' } });
  });

  it.each([false, true])('reutiliza uma única ordenação histórica em mandatos sucessivos (detalhes informados: %s)', async informado => {
    const admin = await usuario(randomUUID(), igreja, 'ADMINISTRADOR');
    const eleito = await pessoa(igreja, 'Presbítero de outra igreja');
    const oficial = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: eleito, tipo: 'PRESBITERO_REGENTE' } });
    const path = '/orgaos/' + conselho + '/mandatos';
    const entrada = await novo(eleito, '2016-01-01', '2016-02-01');
    const ordenacao = informado
      ? { historica: true, data: '1997-02-09', autoridade: 'Conselho da igreja de origem', evidencia: 'Livro I' }
      : { historica: true };
    const conferir = (dados: object) => http('post', path + '/previa', admin.cookie).send(dados);
    const { body: previa } = await conferir({ ...entrada, ordenacao }).expect(201);
    expect(previa.ordenacao_historica).toBe(true);
    expect(await db.registro_historico_oficial.count({ where: { oficial_id: oficial.id } })).toBe(0);
    const confirmar = () => http('post', path, admin.cookie).send({ ...entrada, ordenacao, previa: previa.previa }).expect(201);
    const { body: mandato } = await confirmar();
    await confirmar().expect(201, mandato);
    const registro = await db.registro_historico_oficial.findFirstOrThrow({ where: { oficial_id: oficial.id } });
    expect(registro).toMatchObject({ tipo: 'ORDENACAO', situacao_documental: 'PENDENTE',
      data_evento: informado ? datas('1997-02-09') : null, autoridade: ordenacao.autoridade ?? null, referencia_externa: ordenacao.evidencia ?? null });
    expect(await db.evento_autorizacao.findFirstOrThrow({ where: { recurso_id: mandato.id, acao: 'MANDATO_REGISTRADO' } }))
      .toMatchObject({ dados: { ordenacao_historica_id: registro.id } });
    expect(await membros(conselho, '2016-01-31')).not.toContain(eleito);
    expect(await membros(conselho, '2016-02-01')).toContain(eleito);
    const renovacao = await novo(eleito, '2021-01-01', '2021-02-01');
    await conferir({ ...renovacao, ordenacao }).expect(400);
    const { body: segundaPrevia } = await conferir(renovacao).expect(201);
    expect(segundaPrevia.reeleicao).toBe(true);
    await http('post', path, admin.cookie).send({ ...renovacao, previa: segundaPrevia.previa }).expect(201);
    expect(await db.evento_oficial.count({ where: { oficial_id: oficial.id, tipo: 'ORDENACAO' } })).toBe(1);
    expect(await db.registro_historico_oficial.count({ where: { oficial_id: oficial.id } })).toBe(1);
  });
});
