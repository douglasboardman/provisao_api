import { NavegadorSecretaria, origemFrontend } from './secretaria-navegador';
import { EmailService } from '../src/email/email.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { PDFDocument } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { RascunhosService } from '../src/secretaria/rascunhos.service';
import { ExpedicaoWorkerService } from '../src/secretaria/expedicao-worker.service';
import { createHash, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
integration('Atuação institucional por modelo', () => {
  const igreja = randomUUID(), presidente = randomUUID(), secretario = randomUUID();
  const pPastor = randomUUID(), pSecretario = randomUUID(), cargo = randomUUID();
  const inicio = new Date('2025-01-01'), dia = new Date().toISOString().slice(0, 10);
  let app: INestApplication, db: PrismaService, contexto: string, contextoConselho: string, ataCargo: string, reuniao: string, ocupacao: string;
  let navegador: NavegadorSecretaria | undefined;
  const cookies = new Map<string, string>();
  const sessoesSemConvite: string[] = [];
  const chamada = (u: string, verbo: 'get' | 'post' | 'patch', rota: string) => request(app.getHttpServer())[verbo]('/secretaria/' + rota)
    .set('Cookie', cookies.get(u)!).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  const base = { perfil: 'GERAL', contexto: 'ASSEMBLEIA_GERAL', motivador: 'OPCIONAL', resolucoes: 'OPCIONAL', campos_obrigatorios: [], cargos_obrigatorios: [], papeis_obrigatorios: [] };
  const publicar = (tipo: string, finalidade: string, criar: string[], preparar: string[], assinar: string[] = []) =>
    chamada(secretario, 'post', 'modelos').send({ publicar: true, idempotencia: randomUUID(), nome: finalidade, contexto_id: contexto,
      tipo, finalidade, configuracao: { ...base, atuacao: { criar, preparar, assinar } } });
  const entrada = (modelo: string, r: string | null) => ({ modelo_versao_id: modelo, data_documento: dia, reuniao_id: r, motivador_id: null,
    assunto: 'Documento de teste', conteudo: { teor: 'Teor', campos: {}, arrolados: [], anexos: [] } });
  const criar = (u: string, modelo: string, r: string | null, acao = 'criar') => chamada(u, 'post', 'documentos').send({
    contexto_id: contexto, acao, versao: entrada(modelo, r), restrito: false, idempotencia: randomUUID(),
  });
  async function operador(nome: string, comum = false) {
    const pessoa = await db.pessoas.create({
      data: {
        igreja_id: igreja,
        nome_completo: nome,
        email: randomUUID() + '@example.invalid',
        data_nascimento: inicio,
        sexo: 'MASCULINO',
      },
    });
    const usuario = await db.usuarios.create({
      data: {
        igreja_id: igreja,
        pessoa_id: pessoa.id,
        email_login: pessoa.email!,
        nome_usuario: nome,
        perfil: 'COMUM',
        conta_atuacao: comum,
        senha_hash: 'inutilizavel',
      },
    });
    cookies.set(usuario.id, 'provisao_session=' + (await app.get(SessionService).create(usuario.id, igreja, 0)));
    return { pessoa: pessoa.id, usuario: usuario.id };
  }

  async function assinarEExpedir(
    autoridade: string,
    documento: string,
    signatarios: { pessoa: string; usuario?: string }[],
    tokenDoConvite: (id: string) => string,
  ) {
    const rota = 'documentos/' + documento;
    const ficha = async () => (await chamada(autoridade, 'get', rota).expect(200)).body;
    const inicial = await ficha();
    const v = inicial.versoes[0];
    expect(
      v.arrolados
        .filter((p) => p.assina && p.obrigatorio)
        .map((p) => p.pessoa_id)
        .sort(),
    ).toEqual(signatarios.map((s) => s.pessoa).sort());
    const job = await db.trabalho_renderizacao.findFirstOrThrow({
      where: { versao_id: v.id, finalidade: 'MATRIZ_APROVADA' },
    });
    for (
      let i = 0;
      i < 40 && !(await db.trabalho_renderizacao.findUniqueOrThrow({ where: { id: job.id } })).arquivo_id;
      i++
    )
      await app.get(RascunhosService).executarUm();
    const matriz = (await chamada(autoridade, 'get', rota + '/artefatos/' + job.id + '/arquivo').expect(200)).body;
    let manifesto: string | undefined;
    for (const s of signatarios) {
      expect((await ficha()).estado).toBe('APROVADO');
      const id = v.arrolados.find((a) => a.pessoa_id === s.pessoa).id;
      const r = await chamada(autoridade, 'post', rota + '/assinaturas/convidar')
        .send({
          versao_id: v.id,
          revisao: inicial.revisao,
          arrolado_id: id,
          evidencia: 'Canal pessoal',
          canal_individual: true,
          idempotencia: randomUUID(),
        })
        .expect(201);
      const token = tokenDoConvite(r.body.convite_id);
      const portal = (acao: string) =>
        request(app.getHttpServer())
          .post('/assinaturas/convite/' + acao)
          .set('Cookie', s.usuario ? cookies.get(s.usuario)! : '')
          .set('Origin', 'http://localhost:3001')
          .set('X-Provisao-Request', '1');
      const consulta = (await portal('consulta').send({ token }).expect(201)).body;
      expect(consulta.versao_id).toBe(v.id);
      manifesto ??= consulta.manifesto_sha256;
      expect(consulta.manifesto_sha256).toBe(manifesto);
      const escopo = { token, versao_id: v.id, manifesto_sha256: manifesto };
      await portal('arquivo').send({ ...escopo, versao_id: randomUUID() }).expect(404);
      expect((await portal('arquivo').send(escopo).expect(201)).body).toEqual(matriz);
      if (s.usuario) {
        for (const sessao of sessoesSemConvite) await portal('decisao').set('Cookie', sessao)
          .send({ ...escopo, decisao: 'ASSINAR', consentimento: true }).expect(404);
      }
      if (navegador) await navegador.assinar(token, s.usuario ? cookies.get(s.usuario) : undefined);
      else
        await portal('decisao')
          .send({ ...escopo, decisao: 'ASSINAR', consentimento: true })
          .expect(201);
    }
    for (let i = 0; i < 30 && (await ficha()).estado !== 'EXPEDIDO'; i++)
      await app.get(ExpedicaoWorkerService).executarUm();
    expect((await ficha()).estado).toBe('EXPEDIDO');
    expect(await db.assinatura_documento.count({ where: { versao_id: v.id, manifesto_sha256: manifesto } })).toBe(
      signatarios.length,
    );
    const final = (await chamada(autoridade, 'get', rota + '/assinaturas/' + v.id + '/arquivos/final').expect(200))
      .body;
    expect((await PDFDocument.load(final)).getPageCount()).toBeGreaterThan(0);
    return { versao: v.id, final };
  }
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    if (process.env.E00_NAVEGADOR === '1') {
      app.enableCors({ origin: origemFrontend, credentials: true });
      await app.listen(4298, '127.0.0.1');
      navegador = await NavegadorSecretaria.abrir();
    } else {
      await app.listen(0, '127.0.0.1');
    }
    db = app.get(PrismaService);
    await db.igreja.create({ data: { id: igreja, nome: 'Igreja de teste de atuação', mfa_obrigatorio: false } });
    for (const perfil of ['ADMINISTRADOR', 'AUDITOR'] as const) {
      const u = await db.usuarios.create({ data: { igreja_id: igreja, nome_usuario: perfil, email_login: randomUUID() + '@example.invalid', perfil, senha_hash: 'inutilizavel' } });
      sessoesSemConvite.push('provisao_session=' + await app.get(SessionService).create(u.id, igreja, 0));
    }
    for (const [id, pessoa_id] of [[presidente, pPastor], [secretario, pSecretario]]) {
      await db.pessoas.create({ data: { id: pessoa_id, igreja_id: igreja, nome_completo: 'Pessoa ' + id, data_nascimento: new Date('1980-01-01'), sexo: 'MASCULINO' } });
      await db.usuarios.create({ data: { id, pessoa_id, igreja_id: igreja, nome_usuario: 'Operador', email_login: id + '@example.invalid', perfil: 'COMUM', senha_hash: 'inutilizavel' } });
      cookies.set(id, 'provisao_session=' + await app.get(SessionService).create(id, igreja, 0));
    }
    const orgao = await db.orgao_interno.create({ data: { igreja_id: igreja, nome: 'Conselho', tipo: 'CONSELHO', constituicao: 'OFICIAL', finalidade: 'Conselho', data_criacao: inicio, criador_id: secretario } });
    contexto = (await db.contexto_secretaria.create({ data: { igreja_id: igreja, tipo: 'ASSEMBLEIA_GERAL', nome: 'Assembleia Geral', sigla: 'AG' } })).id;
    await db.cargo_orgao.create({ data: { id: cargo, igreja_id: igreja, orgao_id: orgao.id, codigo: 'SECRETARIO', funcao: 'SECRETARIO', nome: 'Primeiro secretário' } });
    const pastor = await db.oficial.create({ data: { pessoa_id: pPastor, igreja_id: igreja, tipo: 'PRESBITERO_DOCENTE' } });
    await db.vinculo_pastoral.create({ data: { oficial_id: pastor.id, igreja_id: igreja, modalidade: 'Pastor', concilio: 'Concílio', ato: 'Posse', evidencia: 'Registro', data_inicio: inicio, exercicio_institucional: true } });
    await db.presidencia_conselho.create({ data: { igreja_id: igreja, oficial_id: pastor.id, inicio, registrado_por: presidente, evidencia: 'Registro' } });
    await db.eventos_membresia.create({ data: { pessoa_id: pSecretario, igreja_id: igreja, data_evento: inicio, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE' } });
    const oficial = await db.oficial.create({ data: { pessoa_id: pSecretario, igreja_id: igreja, tipo: 'PRESBITERO_REGENTE' } });
    for (const oficial_id of [oficial.id, pastor.id]) await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id, tipo: 'ORDENACAO', data_efeito: inicio, ordem: 1, autoridade: 'Concílio', evidencia: 'Registro' } });
    await db.mandato_oficial.create({ data: { oficial_id: oficial.id, igreja_id: igreja, data_eleicao: inicio, data_posse: inicio, termino_previsto: new Date('2029-12-31'), autoridade: 'Assembleia', evidencia: 'Ata', avaliacao_eleicao: {} } });
    // A vaga inicial é preenchida pela API com as duas provas no contexto do Conselho.
    await db.$executeRaw`SELECT instalar_estrutura_institucional(${igreja}, 'CONSELHO')`;
    contextoConselho = (await db.contexto_secretaria.findUniqueOrThrow({ where: { orgao_id: orgao.id } })).id;
    await db.atribuicao_servico.create({ data: { igreja_id: igreja, usuario_id: presidente, pessoa_id: pPastor, geracao_vinculo: 0,
      acao: 'CARGOS_REGISTRAR', inicio } });
    const modeloAta = await db.modelo_documento.create({ data: { igreja_id: igreja, contexto_id: contextoConselho, nome: 'Deliberação registrada' } });
    const mv = await db.modelo_documento_versao.create({ data: { igreja_id: igreja, contexto_id: contextoConselho, modelo_id: modeloAta.id,
      numero: 1, tipo: 'ATA', finalidade: 'ATA_CONSELHO', configuracao: {} } });
    const d = await db.documento.create({ data: { igreja_id: igreja, contexto_id: contextoConselho, tipo: 'ATA', estado: 'APROVADO', perfil: 'TESTE' } });
    const ata = await db.documento_versao.create({ data: { igreja_id: igreja, contexto_id: contextoConselho, documento_id: d.id, numero: 1,
      modelo_versao_id: mv.id, assunto: 'Eleição e posse', data_documento: new Date(dia), conteudo: { teor: 'Eleição registrada' } } });
    ataCargo = ata.id;
    const dadosCargo = { pessoa_id: pSecretario, data_eleicao: dia, data_posse: dia, termino_previsto: '2029-12-31',
      autoridade: 'Conselho', evidencia: 'Itens 2 e 3 da ata', comprovacao: {
        eleicao: { versao_id: ata.id, trecho: 'Item 2, eleição' }, posse: { versao_id: ata.id, trecho: 'Item 3, posse' },
      } };
    const rotaCargo = '/orgaos/gestao/' + orgao.id + '/cargos/' + cargo + '/eleicao-oficial';
    const postCargo = (body: object) => request(app.getHttpServer()).post(rotaCargo).set('Cookie', cookies.get(presidente)!)
      .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send(body);
    const disputa = await Promise.all([postCargo({ ...dadosCargo, idempotencia: randomUUID() }), postCargo({ ...dadosCargo, idempotencia: randomUUID() })]);
    expect(disputa.map(r => r.status).sort()).toEqual([201,409]);
    ocupacao = disputa.find(r => r.status === 201)!.body.ocupacao_id;
    expect(await db.referencia_ata_institucional.count({ where: { versao_id: ata.id } })).toBe(2);
    const dados = { restrito: false, modalidade: 'AGO', data: dia, local: 'Templo', inicio: null, fim: null, pauta: 'Pauta', competencia: 'Assembleia', universo_informado: 0, quorum_minimo: 0, quorum_conferido: false, fundamento_quorum: '', resultado: '', participantes: [] };
    reuniao = (await chamada(presidente,'post','reunioes').send({ contexto_id: contexto, dados, idempotencia: randomUUID() }).expect(201)).body.id;
  });
  afterAll(async () => { await navegador?.fechar(); if (app) await app.close(); });

  it('aplica o sigilo de ata do Conselho por mandato inclusive na listagem e após reclassificação', async () => {
    const prova = await db.documento_versao.findUniqueOrThrow({ where: { id: ataCargo } });
    const documento = await db.documento.create({ data: { igreja_id: igreja, contexto_id: contextoConselho,
      tipo: 'ATA', estado: 'APROVADO', perfil: 'TESTE' } });
    await db.documento_versao.create({ data: { igreja_id: igreja, contexto_id: contextoConselho, documento_id: documento.id,
      numero: 1, assunto: 'Deliberação de teste', conteudo: { teor: 'Teor reservado' },
      data_documento: inicio, modelo_versao_id: prova.modelo_versao_id } });
    const semMandato = await operador('Secretário com competência técnica');
    await db.competencia_secretaria.create({ data: { igreja_id: igreja, contexto_id: contextoConselho,
      usuario_id: semMandato.usuario, pessoa_id: semMandato.pessoa, pode_consultar_restritos: true, pode_aprovar: false, pode_deliberar: false,
      registrado_por_id: presidente, inicio, autoridade: 'Igreja', evidencia: 'Teste' } });
    const rota = 'documentos/' + documento.id;
    const restringir = { restrito: true, revisao: documento.revisao, idempotencia: randomUUID() };
    await chamada(semMandato.usuario, 'post', rota + '/sigilo').send(restringir).expect(403);
    await chamada(secretario, 'post', rota + '/sigilo').send(restringir).expect(201);
    await chamada(secretario, 'post', rota + '/sigilo').send(restringir).expect(201);
    await chamada(presidente, 'get', rota).expect(200);
    await chamada(semMandato.usuario, 'get', rota).expect(404);
    const listar = async (u: string) => (await chamada(u, 'get', 'documentos')
      .query({ contexto: contextoConselho }).expect(200)).body.map(d => d.id);
    expect(await listar(semMandato.usuario)).not.toContain(documento.id);
    expect(await listar(secretario)).toContain(documento.id);
    const conta = await db.usuarios.update({ where: { id: secretario }, data: { perfil: 'COMUM' } });
    const sessaoAnterior = cookies.get(secretario)!;
    try {
      cookies.set(secretario, 'provisao_session=' + await app.get(SessionService).create(conta.id, igreja, conta.auth_version));
      const contextos = (await chamada(secretario, 'get', 'contextos').expect(200)).body;
      expect(contextos).toContainEqual(expect.objectContaining({ id: contextoConselho, somente_atas: true, pode_classificar_ata: true }));
      expect(await listar(secretario)).toContain(documento.id);
      await chamada(secretario, 'get', rota).expect(200);
      await chamada(secretario, 'get', 'locais').expect(403);
      await chamada(secretario, 'post', rota + '/sigilo')
        .send({ restrito: false, revisao: documento.revisao + 1, idempotencia: randomUUID() }).expect(201);
      await chamada(semMandato.usuario, 'get', rota).expect(200);
    } finally {
      await db.usuarios.update({ where: { id: secretario }, data: { perfil: 'COMUM' } });
      cookies.set(secretario, sessaoAnterior);
    }
  });

  it('registra eleição histórica com atas posteriores e exige encerramento autorizado para trocar de titular', async () => {
    const c = await db.contexto_secretaria.findUniqueOrThrow({ where: { id: contextoConselho } });
    const segundo = await db.cargo_orgao.findFirstOrThrow({ where: { igreja_id: igreja, orgao_id: c.orgao_id, codigo: 'SEGUNDO_SECRETARIO' } });
    const original = await db.documento_versao.findUniqueOrThrow({ where: { id: ataCargo } });
    const ata = async (data: string) => {
      const d = await db.documento.create({ data: { igreja_id: igreja, contexto_id: c.id, tipo: 'ATA', estado: 'APROVADO', perfil: 'TESTE' } });
      return db.documento_versao.create({ data: { igreja_id: igreja, contexto_id: c.id, documento_id: d.id, numero: 1,
        modelo_versao_id: original.modelo_versao_id, assunto: 'Ata histórica', data_documento: new Date(data), conteudo: { teor: 'Ata de teste.' } } });
    };
    const prova = { versao_id: (await ata('2025-03-01')).id, trecho: 'Eleição e posse no item 3' };
    const enviar = (confirmar: boolean, fim: string) => request(app.getHttpServer()).post('/orgaos/gestao/' + c.orgao_id + '/cargos/' + segundo.id + '/eleicao-oficial')
      .set('Cookie', cookies.get(presidente)!).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1')
      .send({ pessoa_id: pSecretario, data_eleicao: '2025-03-01', data_posse: '2025-03-01', termino_previsto: fim,
        autoridade: 'Conselho', evidencia: 'Ata', idempotencia: randomUUID(),
        comprovacao: { eleicao: prova, posse: prova, ...(confirmar && { confirmar_historico: true }) } });
    await enviar(false,'2025-04-01').expect(400);
    const ataPosterior = await ata('2025-05-01');
    const registro = (await enviar(true,'2025-06-01').expect(201)).body;
    await enviar(true,'2025-06-01').expect(409);

    const responsavel = await operador('Responsável pela sucessão');
    const sucessao = { pessoa_id: pPastor, data_eleicao: '2025-05-01', data_posse: '2025-06-02',
      termino_previsto: '2025-12-31', idempotencia: randomUUID(), comprovacao: { confirmar_historico: true,
        eleicao: { versao_id: ataPosterior.id }, posse: { versao_id: ataPosterior.id } } };
    const rota = '/orgaos/gestao/' + c.orgao_id;
    const pedido = (verbo: 'post' | 'patch', caminho: string) => request(app.getHttpServer())[verbo](rota + caminho)
      .set('Cookie', cookies.get(responsavel.usuario)!).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    const substituir = () => pedido('post', '/cargos/' + segundo.id + '/eleicao-oficial').send(sucessao);
    const fim = { data_efeito: '2025-06-02', idempotencia: randomUUID(), autoridade: 'Conselho', evidencia: 'Ata da troca',
      motivo: 'Sucessão', comprovacao: { versao_id: (await ata('2025-06-10')).id, trecho: 'Mudança da mesa' } };
    const encerrar = () => pedido('patch', '/ocupacoes/' + registro.ocupacao_id + '/encerrar-oficial').send(fim);
    await substituir().expect(403);
    await encerrar().expect(403);
    await db.atribuicao_servico.create({ data: { igreja_id: igreja, usuario_id: responsavel.usuario,
      pessoa_id: responsavel.pessoa, geracao_vinculo: 0, acao: 'CARGOS_REGISTRAR', inicio } });
    await substituir().expect(409);
    await encerrar().expect(200);
    await encerrar().expect(200);
    const nova = (await substituir().expect(201)).body;
    await substituir().expect(201, nova);
    const anterior = await db.ocupacao_cargo.findUniqueOrThrow({ where: { id: registro.ocupacao_id } });
    const seguinte = await db.ocupacao_cargo.findUniqueOrThrow({ where: { id: nova.ocupacao_id } });
    expect(anterior.fim).toEqual(seguinte.inicio);
    expect(anterior.fim_ordem).toBeLessThan(seguinte.inicio_ordem);
    expect(await db.ato_orgao.findUniqueOrThrow({ where: { id: nova.ato_id } }))
      .toMatchObject({ operador_id: responsavel.usuario, detalhes: { continuidade: 'SUCESSAO', sucede_id: anterior.id } });
    expect(await db.ato_orgao.findUniqueOrThrow({ where: { id: registro.ato_id }, select: { detalhes: true } }))
      .toMatchObject({ detalhes: { transcricao_historica: true, versao_orgao_id: expect.any(String) } });
  });

  it('emite folhas históricas e instala a mesa com pastor, eleição pastoral e ausência', async () => {
    const eleita = await db.pessoas.create({ data: { igreja_id: igreja, nome_completo: 'Secretária eleita', sexo: 'FEMININO', data_nascimento: inicio } });
    await db.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: eleita.id, data_evento: inicio, tipo_evento: 'ADMISSAO', rol: 'NAO_COMUNGANTES', motivacao_evento: 'BATISMO_NA_INFANCIA' } });
    const dados = { restrito: false, modalidade: 'AGO', data: dia, local: 'Templo', inicio: null, fim: null, pauta: 'Preparação da assembleia',
      competencia: 'Assembleia', universo_informado: 0, quorum_minimo: 0, quorum_conferido: false, fundamento_quorum: '', resultado: '', participantes: [] };
    const nova = async () => (await chamada(presidente,'post','reunioes').send({ contexto_id: contexto, dados, idempotencia: randomUUID() }).expect(201)).body.id;
    const id = await nova();
    const rota = 'reunioes/'+id+'/assembleia';
    const folhaCmd = { referencia: dia, idempotencia: randomUUID() };
    const f1 = (await chamada(secretario,'post',rota+'/folhas').send(folhaCmd).expect(201)).body.id;
    expect((await chamada(secretario,'post',rota+'/folhas').send(folhaCmd).expect(201)).body.id).toBe(f1);
    const folha = async () => (await chamada(secretario,'get',rota+'/folhas/'+f1).expect(200)).body;
    expect((await folha()).linhas).toEqual(expect.arrayContaining([expect.objectContaining({ pessoa_id: eleita.id, categoria: 'NAO_COMUNGANTES' }), expect.objectContaining({ pessoa_id: pSecretario, categoria: 'COMUNGANTES' })]));
    await db.pessoas.update({ where: { id: eleita.id }, data: { nome_completo: 'Secretária confirmada' } });
    expect((await folha()).linhas.find(p => p.pessoa_id === eleita.id).nome).toBe('Secretária eleita');
    const f2 = (await chamada(secretario,'post',rota+'/folhas').send({ ...folhaCmd, idempotencia: randomUUID() }).expect(201)).body.id;
    expect((await chamada(secretario,'get',rota+'/folhas/'+f2).expect(200)).body).toMatchObject({ versao: 2, linhas: expect.arrayContaining([expect.objectContaining({ nome: 'Secretária confirmada' })]) });
    await Promise.all([1,2].map(() => chamada(secretario,'post',rota+'/folhas').send({ ...folhaCmd, idempotencia: randomUUID() }).expect(201)));
    expect((await chamada(secretario,'get',rota).expect(200)).body.folhas.map(f => f.versao)).toEqual([4,3,2,1]);
    await chamada(presidente,'get',rota+'/folhas/'+f1).expect(403);
    expect(await db.participante_reuniao.count({ where: { reuniao_id: id } })).toBe(0);
    const convocante = await db.campo_secretaria.findFirstOrThrow({ where: { igreja_id: igreja, codigo: 'NOME_CONVOCANTE' } });
    const convocacao = (await chamada(secretario,'post','modelos').send({ contexto_id: contexto, publicar: true, nome: 'Edital da assembleia', tipo: 'OUTRO',
      finalidade: 'CONVOCACAO', idempotencia: randomUUID(), configuracao: { ...base, obrigatorios_biblioteca: [convocante.id], atuacao: { criar: ['PRESIDENCIA_CONSELHO'], preparar: [], assinar: [] } } }).expect(201)).body;
    const edital = (await criar(presidente,convocacao.versao_id,id).expect(201)).body;
    const lerConvocante = async () => (await chamada(presidente,'get','documentos/'+edital.id).expect(200)).body.versoes[0].conteudo.valores[convocante.id];
    const autorEdital = await lerConvocante();
    expect(autorEdital.origem.registro_id).toBe(pPastor);
    const camposMesa = await db.campo_secretaria.findMany({ where: { igreja_id: igreja, codigo: { in: ['NOME_PRESIDENTE_MESA','NOME_SECRETARIO_MESA','REDATOR_ATA'] } } });
    expect(camposMesa).toHaveLength(3);
    const mm = (await chamada(secretario,'post','modelos').send({ contexto_id: contexto, publicar: true, nome: 'Ata da sessão', tipo: 'ATA', finalidade: 'ATA_AGO',
      idempotencia: randomUUID(), configuracao: { ...base, obrigatorios_biblioteca: camposMesa.map(c => c.id), atuacao: { criar: ['PRESIDENCIA_CONSELHO'], preparar: [cargo], assinar: [] } } }).expect(201)).body;
    const minuta = (await criar(secretario,mm.versao_id,id,'preparar').expect(201)).body;
    expect((await chamada(secretario,'get','documentos/'+minuta.id).expect(200)).body.versoes[0].conteudo.redator_ata).toBeNull();
    const acesso = await db.competencia_secretaria.create({ data: { igreja_id: igreja, usuario_id: secretario, contexto_id: contexto, pessoa_id: pSecretario,
      inicio, registrado_por_id: presidente, pode_instalar_mesa: true, pode_aprovar: false, pode_deliberar: true, pode_consultar_restritos: false, autoridade: 'Igreja', evidencia: 'Designação para instalação' } });
    const opcoes = (await chamada(secretario,'get',rota).expect(200)).body;
    const pastor = opcoes.oficiais.find(o => o.pessoa_id === pPastor);
    const oficial = opcoes.oficiais.find(o => o.pessoa_id === pSecretario);
    expect(opcoes.institucional).toBe(pastor.id);
    const cmd = { revisao: 1, idempotencia: randomUUID(), presidente_oficial_id: pastor.id, secretario_id: eleita.id,
      confirmar_presencas: [pPastor, eleita.id, pSecretario], votantes_confirmados: [pSecretario], universo: 4, quorum: { minimo: 1, competencia: 'Assembleia', fundamento: 'Conferência dos presentes' }, motivo: 'PRESIDENCIA_INSTITUCIONAL', fundamento: 'Eleição registrada', vigente_desde: dia+'T00:00:00Z' };
    await chamada(presidente,'post',rota+'/mesa').send(cmd).expect(403);
    await chamada(secretario,'post',rota+'/mesa').send({ ...cmd, confirmar_presencas: [pPastor] }).expect(400);
    const insuficiente = { ...cmd, quorum: { ...cmd.quorum, minimo: 2 }, idempotencia: randomUUID() };
    await chamada(secretario,'post',rota+'/mesa').send({...cmd,votantes_confirmados:undefined}).expect(400);
    const recusada = await chamada(secretario, 'post', rota + '/mesa').send(insuficiente).expect(400);
    expect(recusada.body.message).toContain('quórum');
    expect((await chamada(secretario, 'get', rota).expect(200)).body.mesas).toHaveLength(0);
    await chamada(secretario,'post',rota+'/mesa').send(cmd).expect(201);
    const lerAta = async () => (await chamada(secretario,'get','documentos/'+minuta.id).expect(200)).body.versoes[0];
    expect((await lerAta()).conteudo.redator_ata.pessoa_id).toBe(eleita.id);
    const documento = (await chamada(secretario,'get','documentos/'+minuta.id).expect(200)).body;
    await chamada(secretario,'post','documentos/'+minuta.id+'/deliberar').send({ revisao: documento.revisao, reuniao_id: id, resultado: 'APROVADA',
      autoridade: 'Assembleia', evidencia: 'Leitura em sessão', data: dia, idempotencia: randomUUID() }).expect(201);
    const troca = { ...cmd, revisao: 2, idempotencia: randomUUID(), presidente_oficial_id: oficial.id, secretario_id: pPastor,
      confirmar_presencas: [pSecretario,pPastor], criterio_presidencia: { impedimentos: [], determinacao_presbiterio: 'Ato específico para a eleição pastoral' }, motivo: 'ELEICAO_PASTORAL', vigente_desde: new Date().toISOString() };
    await chamada(secretario,'post',rota+'/mesa').send({ ...troca, motivo: 'AUSENCIA' }).expect(400);
    const resultado = await chamada(secretario,'post',rota+'/mesa').send(troca).expect(201);
    expect((await chamada(secretario,'post',rota+'/mesa').send(troca).expect(201)).body.id).toBe(resultado.body.id);
    expect(await lerConvocante()).toEqual(autorEdital);
    const ata = await lerAta();
    expect(ata.conteudo.redator_ata.pessoa_id).toBe(pPastor);
    expect(ata.arrolados.filter(p => p.assina && p.obrigatorio).map(p => p.pessoa_id).sort()).toEqual([pSecretario,pPastor].sort());
    for (const c of camposMesa) expect(ata.conteudo.valores[c.id].valor).toBe(c.codigo === 'NOME_PRESIDENTE_MESA' ? oficial.nome : pastor.nome);
    const decisao = await db.deliberacao_ata.findFirstOrThrow({ where: { reuniao_id: id }, include: { mesa: true } });
    expect(decisao.mesa).toMatchObject({ ordem: 1, presidente_oficial_id: pastor.id, secretario_id: eleita.id });
    const historico = (await chamada(secretario,'get',rota).expect(200)).body.mesas;
    expect(historico.map(m => [m.ordem,m.oficial.pessoa_id])).toEqual([[2,pSecretario],[1,pPastor]]);
    const semPastor = await nova();
    await chamada(secretario,'post','reunioes/'+semPastor+'/assembleia/mesa').send({ ...cmd, idempotencia: randomUUID(), presidente_oficial_id: oficial.id, confirmar_presencas: [pSecretario,eleita.id], motivo: 'AUSENCIA',
      criterio_presidencia: { impedimentos: [{ oficial_id: pastor.id, motivo: 'AUSENTE', fundamento: 'Ausência do pastor' }],
        determinacao_presbiterio: 'Ato de condução da sessão na ausência dos titulares' } }).expect(201);
    await chamada(secretario,'get','reunioes/'+semPastor+'/assembleia/folhas/'+f1).expect(404);
    await db.competencia_secretaria.update({ where: { id: acesso.id }, data: { fim: new Date(dia) } });
    await chamada(secretario,'post',rota+'/mesa').send(troca).expect(403);
  });

  it('exige a ordem da presidência e distingue votação da presença na sessão', async () => {
    const id = (await chamada(presidente,'post','reunioes').send({ contexto_id:contexto, idempotencia:randomUUID(),
      dados:{ restrito:false, modalidade:'AGO',data:dia,local:'Templo',pauta:'Pauta',competencia:'Assembleia',
        universo_informado:0,quorum_minimo:0,quorum_conferido:false,fundamento_quorum:'',resultado:'',participantes:[] } }).expect(201)).body.id;
    const pastor = await db.oficial.findFirstOrThrow({where:{pessoa_id:pPastor,igreja_id:igreja}});
    const novo = await operador('Pastor auxiliar');
    const oficial = await db.oficial.create({data:{igreja_id:igreja,pessoa_id:novo.pessoa,tipo:'PRESBITERO_DOCENTE'}});
    await db.evento_oficial.create({data:{igreja_id:igreja,oficial_id:oficial.id,tipo:'ORDENACAO',data_efeito:inicio,ordem:1,autoridade:'Presbitério',evidencia:'Registro'}});
    const vinculo = await db.vinculo_pastoral.create({data:{igreja_id:igreja,oficial_id:oficial.id,modalidade:'Pastor Auxiliar',
      concilio:'Presbitério',ato:'Designação',evidencia:'Registro',data_inicio:inicio,exercicio_institucional:true}});
    const comp = await db.competencia_secretaria.create({data:{igreja_id:igreja,contexto_id:contexto,pessoa_id:pPastor,usuario_id:presidente,
      registrado_por_id:secretario,autoridade:'Conselho',evidencia:'Registro',inicio,pode_instalar_mesa:true,pode_aprovar:false,pode_deliberar:false,pode_consultar_restritos:false}});
    const path = 'reunioes/'+id+'/assembleia';
    try {
      const ficha = (await chamada(presidente,'get',path).expect(200)).body;
      expect(ficha.prioridade[0].ids).toContain(pastor.id);
      expect(ficha.prioridade[1].ids).toContain(oficial.id);
      const instalar = (dados: object) => chamada(presidente,'post',path+'/mesa').send({
        revisao:1,idempotencia:randomUUID(),presidente_oficial_id:oficial.id,secretario_id:pSecretario,confirmar_presencas:[novo.pessoa,pSecretario],
        universo:2,vigente_desde:dia+'T00:00:00Z',motivo:'AUSENCIA',fundamento:'Titular ausente',
        quorum:{minimo:2,competencia:'Assembleia',fundamento:'Rol conferido'},votantes_confirmados:[pSecretario],...dados
      });
      await instalar({}).expect(400);
      const criterio_presidencia = { impedimentos:[{oficial_id:pastor.id,motivo:'AUSENTE',fundamento:'Ausência registrada'}] };
      await instalar({criterio_presidencia,votantes_confirmados:[pSecretario,novo.pessoa]}).expect(400);
      expect((await instalar({criterio_presidencia}).expect(400)).body.message).toMatch(/Votantes presentes/);
      await instalar({criterio_presidencia,quorum:{minimo:1,competencia:'Assembleia',fundamento:'Rol conferido'}}).expect(201);
      expect((await chamada(presidente,'get',path).expect(200)).body.votacao).toMatchObject({presentes:2,votantes_presentes:[pSecretario]});
    } finally {
      await db.vinculo_pastoral.update({where:{id:vinculo.id},data:{exercicio_institucional:false}});
      await db.competencia_secretaria.update({where:{id:comp.id},data:{fim:new Date(dia)}});
    }
  });

  it.each(['PRESIDENCIA_INSTITUCIONAL', 'ELEICAO_PASTORAL', 'AUSENCIA'])(
    'expede a ata com as duas assinaturas da mesa em %s, da eleição do secretário à consulta da matriz',
    async (motivo) => {
      const antigo = process.env.FEATURE_SECRETARIA_ASSINATURAS;
      process.env.FEATURE_SECRETARIA_ASSINATURAS = 'true';
      const fila = app.get(OutboxService);
      const email = jest.spyOn(app.get(EmailService), 'sendAssemblyInvitation').mockResolvedValue(undefined);
      const convites = jest.spyOn(fila, 'enqueueAssembly'),
        assinaturas = jest.spyOn(fila, 'enqueueSignature');
      try {
        const guest = await db.pessoas.create({
          data: {
            igreja_id: igreja,
            nome_completo: 'Secretária da sessão',
            email: randomUUID() + '@example.invalid',
            sexo: 'FEMININO',
            data_nascimento: inicio,
          },
        });
        for (const [id, u] of [
          [pPastor, presidente],
          [pSecretario, secretario],
        ])
          await db.pessoas.update({ where: { id }, data: { email: u + '@example.invalid' } });
        const r = (
          await chamada(presidente, 'post', 'reunioes')
            .send({
              contexto_id: contexto,
              idempotencia: randomUUID(),
              dados: {
                restrito: false,
                modalidade: 'AGO',
                data: dia,
                local: 'Templo',
                pauta: 'Pauta',
                competencia: 'Assembleia',
                universo_informado: 0,
                quorum_minimo: 0,
                quorum_conferido: false,
                fundamento_quorum: '',
                resultado: '',
                participantes: [],
              },
            })
            .expect(201)
        ).body.id;
        const instalador = motivo === 'AUSENCIA' ? secretario : presidente;
        const comp = await db.competencia_secretaria.create({
          data: {
            igreja_id: igreja,
            contexto_id: contexto,
            usuario_id: instalador,
            pessoa_id: instalador === secretario ? pSecretario : pPastor,
            registrado_por_id: instalador === secretario ? presidente : secretario,
            inicio,
            pode_instalar_mesa: true,
            pode_aprovar: true,
            pode_deliberar: false,
            pode_consultar_restritos: false,
            autoridade: 'Conselho',
            evidencia: 'Designação de teste',
          },
        });
        const institucional = motivo === 'PRESIDENCIA_INSTITUCIONAL';
        const pessoaPresidente = institucional ? pPastor : pSecretario;
        const presidenteDaMesa = institucional ? presidente : secretario;
        const oficial = await db.oficial.findFirstOrThrow({ where: { pessoa_id: pessoaPresidente } });
        const auxiliar = await operador('Primeiro secretário eleito', true);
        const edital = (await publicar('OUTRO', 'CONVOCACAO', ['PRESIDENCIA_CONSELHO'], []).expect(201)).body;
        const conteudo = entrada(edital.versao_id, r);
        const convocacao = (
          await chamada(presidente, 'post', 'documentos')
            .send({
              contexto_id: contexto,
              restrito: false,
              idempotencia: randomUUID(),
              versao: {
                ...conteudo,
                assunto: 'Edital da assembleia',
                conteudo: {
                  ...conteudo.conteudo,
                  arrolados: [
                    {
                      pessoa_id: pPastor,
                      papeis: ['PRESIDENTE'],
                      responsavel: true,
                      assina: true,
                      obrigatorio: true,
                      fundamento: 'Presidência do Conselho',
                    },
                  ],
                },
              },
            })
            .expect(201)
        ).body.id;
        const cmdEdital = { autoridade: 'Conselho', evidencia: 'Edital conferido' };
        await chamada(presidente, 'post', 'documentos/' + convocacao + '/encaminhar')
          .send({ ...cmdEdital, revisao: 1, idempotencia: randomUUID() })
          .expect(201);
        await chamada(instalador, 'post', 'documentos/' + convocacao + '/aprovar')
          .send({ ...cmdEdital, revisao: 2, idempotencia: randomUUID(), modalidade: 'ELETRONICA' })
          .expect(201);
        const tokenAssinatura = (id: string) => assinaturas.mock.calls.find((c) => c[1] === id)![2];
        const expedida = await assinarEExpedir(
          instalador,
          convocacao,
          [{ pessoa: pPastor, usuario: presidente }],
          tokenAssinatura,
        );
        await db.eventos_membresia.create({
          data: {
            igreja_id: igreja,
            pessoa_id: guest.id,
            data_evento: inicio,
            tipo_evento: 'ADMISSAO',
            rol: 'NAO_COMUNGANTES',
            motivacao_evento: 'BATISMO_NA_INFANCIA',
          },
        });
        const folha = (
          await chamada(secretario, 'post', 'reunioes/' + r + '/assembleia/folhas')
            .send({ referencia: dia, idempotencia: randomUUID() })
            .expect(201)
        ).body;
        const linhas = (
          await chamada(secretario, 'get', 'reunioes/' + r + '/assembleia/folhas/' + folha.id).expect(200)
        ).body.linhas;
        expect(linhas.map((p) => p.categoria)).toEqual(expect.arrayContaining(['COMUNGANTES', 'NAO_COMUNGANTES']));
        const m = (await publicar('ATA', 'ATA_AGO', ['SECRETARIO_MESA'], [cargo]).expect(201)).body;
        let redator: string = secretario;
        if (institucional) {
          const u = await db.usuarios.create({data:{igreja_id:igreja,pessoa_id:pSecretario,perfil:'COMUM',conta_atuacao:true,
            email_login:randomUUID()+'@example.invalid',nome_usuario:'Secretário do Conselho',senha_hash:'inutilizavel'}});
          cookies.set(u.id,'provisao_session='+await app.get(SessionService).create(u.id,igreja,0));
          redator = u.id;
          await criar(redator,m.versao_id,r).expect(403);
        }
        const d = (await criar(redator, m.versao_id, r, 'preparar').expect(201)).body;
        const v = await db.documento_versao.findFirstOrThrow({ where: { documento_id: d.id } });
        const rota = 'reunioes/' + r;
        const instalar = async (quem: string, revisao: number, desde: string) =>
          (
            await chamada(instalador, 'post', rota + '/assembleia/mesa')
              .send({
                revisao,
                idempotencia: randomUUID(),
                presidente_oficial_id: oficial.id,
                secretario_id: quem,
                confirmar_presencas: [...new Set([pessoaPresidente, quem, pSecretario, ...(motivo === 'ELEICAO_PASTORAL' ? [pPastor] : [])])],
                universo: 5,
                quorum: { minimo: 1, competencia: 'Assembleia', fundamento: 'Quórum conferido' },
                votantes_confirmados: [pSecretario],
                motivo,
                ...(!institucional && { criterio_presidencia: { impedimentos: [], determinacao_presbiterio: 'Ato específico para esta sessão' } }),
                fundamento: 'Eleição presencial',
                vigente_desde: desde,
              })
              .expect(201)
          ).body.id;
        const conceder = async (mesa_id: string) =>
          (
            await chamada(presidenteDaMesa, 'post', rota + '/presidencia/conceder')
              .send({
                mesa_id,
                versao_id: v.id,
                idempotencia: randomUUID(),
                expira_em: new Date(Date.now() + 3600000).toISOString(),
              })
              .expect(201)
          ).body.id;
        const token = (id: string) => convites.mock.calls.find((c) => c[1] === id)![2];
        const portal = (url: string) =>
          request(app.getHttpServer()).post(url).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
        const aceitar = (id: string) => portal('/minha-assembleia/ativar').send({ token: token(id) });
        const ativar = async (id: string, normal?: string) => {
          const q = aceitar(id);
          if (normal) q.set('Cookie', normal);
          const rsp = await q.expect(201);
          return String(rsp.headers['set-cookie'][0]).split(';')[0] + (normal ? '; ' + normal : '');
        };
        const ficha = (id: string, ck: string) =>
          request(app.getHttpServer())
            .get('/minha-assembleia?acesso=' + id)
            .set('Cookie', ck);
        const antes = await instalar(auxiliar.pessoa, 1, dia + 'T00:00:00Z');
        await chamada(institucional ? secretario : presidente, 'get', rota + '/presidencia').expect(403);
        const antiga = await conceder(antes);
        await aceitar(antiga).expect(401);
        const pessoal = cookies.get(auxiliar.usuario)!;
        const sessaoAntiga = await ativar(antiga, pessoal);
        await ficha(antiga, sessaoAntiga).expect(200);
        const mesa = await instalar(guest.id, 2, new Date().toISOString());
        if (institucional) {
          await criar(redator,m.versao_id,r,'preparar').expect(403);
          expect((await chamada(redator,'get','documentos/'+d.id).expect(200)).body.atuacao).toEqual({criar:false,preparar:false});
          await db.usuarios.update({where:{id:redator},data:{conta_atuacao:false}});
        }
        await ficha(antiga, sessaoAntiga).expect(403);
        expect((await db.acesso_assembleia.findUniqueOrThrow({where:{id:antiga}})).revogado_em).not.toBeNull();
        await chamada(presidenteDaMesa,'post','reunioes/'+reuniao+'/presidencia/conceder').send({mesa_id:mesa,versao_id:v.id,
          expira_em:new Date(Date.now()+3600000).toISOString(),idempotencia:randomUUID()}).expect(403);
        const limitado = await request(app.getHttpServer()).get('/minha-assembleia/pessoas?busca='+encodeURIComponent(auxiliar.pessoa)+'&acesso='+antiga)
          .set('Cookie',sessaoAntiga).expect(403);
        expect(limitado.body.statusCode).toBe(403);
        await chamada(secretario, 'get', 'contextos').expect(200);
        const a = await conceder(mesa),
          b = await conceder(mesa);
        await aceitar(a).expect(403);
        await chamada(presidenteDaMesa, 'post', rota + '/presidencia/' + b + '/revogar').expect(201);
        await aceitar(b).expect(403);
        const expirado = await conceder(mesa);
        await db.acesso_assembleia.update({ where: { id: expirado }, data: { expira_em: new Date(0) } });
        await aceitar(expirado).expect(403);
        let id = navegador ? await navegador.conceder(r, v.id, cookies.get(presidenteDaMesa)!) : await conceder(mesa);
        await db.outbox_email.update({
          where: { acesso_assembleia_id: id },
          data: { created_at: new Date(0), proxima_tentativa: new Date(0) },
        });
        await fila.runOnce();
        const entrega = email.mock.calls.find((c) => c[3] === id);
        expect(entrega?.[1]).toBe(guest.email);
        expect(new URL(entrega![2]).hash.slice(1)).toBe(token(id));
        let cookie = navegador ? await navegador.ativarERedigir(token(id)) : await ativar(id);
        const sairOutra = await portal('/minha-assembleia/sair?acesso=' + antiga)
          .set('Cookie', cookie)
          .send({})
          .expect(201);
        expect(sairOutra.headers['set-cookie']).toBeUndefined();
        await aceitar(id).expect(403);
        await ficha(antiga, cookie).expect(403);
        await request(app.getHttpServer()).get('/secretaria/contextos').set('Cookie', cookie).expect(401);
        const f = async () => (await ficha(id, cookie).expect(200)).body;
        const gravar = async (acao: string, dados: object) => {
          const s = await f();
          return portal('/minha-assembleia/' + acao + '?acesso=' + id)
            .set('Cookie', cookie)
            .send({ revisao: s.revisao, revisao_reuniao: s.revisao_reuniao, ...dados })
            .expect(201);
        };
        const s = await f();
        if (institucional) {
          expect(s.votacao).toMatchObject({ base:'VOTANTES_CONFIRMADOS', votantes_presentes:[pSecretario] });
          expect(s.pessoas.find(p => p.id === guest.id)).toMatchObject({ direito_voto:false, presente:true });
          const alheio = await operador('Pessoa de outra sessão');
          await db.eventos_membresia.create({data:{igreja_id:igreja,pessoa_id:alheio.pessoa,data_evento:inicio,
            tipo_evento:'ADMISSAO',rol:'COMUNGANTES',motivacao_evento:'PROFISSAO_DE_FE'}});
          const resultado = await request(app.getHttpServer()).get('/minha-assembleia/pessoas').query({acesso:id,busca:'Pessoa de outra sessão'})
            .set('Cookie',cookie).expect(200);
          expect(resultado.body).toEqual([]);
        }
        const anexos = '/minha-assembleia/anexos/' + randomUUID();
        await request(app.getHttpServer())
          .get(anexos + '?acesso=' + id)
          .set('Cookie', cookie)
          .expect(404);
        await request(app.getHttpServer())
          .get('/minha-assembleia/pessoas?busca=Pessoa&acesso=' + antiga)
          .set('Cookie', cookie)
          .expect(403);
        await portal('/minha-assembleia/salvar?acesso=' + antiga)
          .set('Cookie', cookie)
          .send({ teor: 'Teste', resolucoes: [], revisao: s.revisao, revisao_reuniao: s.revisao_reuniao })
          .expect(403);
        await portal('/minha-assembleia/salvar?acesso=' + id)
          .set('Cookie', cookie)
          .send({
            teor: 'Teste',
            campos: { CAMPO_INDISPONIVEL: 'valor' },
            resolucoes: [],
            revisao: s.revisao,
            revisao_reuniao: s.revisao_reuniao,
          })
          .expect(400);
        await gravar('presencas', {
          pessoas: s.pessoas.map(({ id, presente, arrolado, pode_propor }) => ({
            id,
            presente,
            arrolado,
            pode_propor,
          })),
          universo: 5,
          minimo: 1,
          conferir: true,
          competencia: 'Assembleia',
          fundamento: 'Mesa e participantes confirmados',
        });
        if (institucional) {
          const sessao = await f();
          await portal('/minha-assembleia/salvar?acesso=' + id).set('Cookie',cookie).send({
            revisao:sessao.revisao, revisao_reuniao:sessao.revisao_reuniao, teor:'Texto da revisão',
            resolucoes:[{ordem:1,assunto:'Expediente',texto_deliberado:'Deliberação',resultado:'APROVADA',eficaz:false,votacao_secreta:false,
              apuracao:{favoraveis:2},proponentes_pessoas_ids:[],dissidentes_pessoas_ids:[]}]
          }).expect(400).expect(res => expect(res.body.message).toMatch(/apuracao excede|apuração excede/));
        }
        await gravar('salvar', {
          teor: 'Ata lida e conferida pelos presentes.',
          resolucoes: [
            {
              ordem: 1,
              assunto: 'Expediente',
              texto_deliberado: 'Aprovar a pauta',
              resultado: 'APROVADA',
              eficaz: false,
              votacao_secreta: false,
              proponentes_pessoas_ids: [],
              dissidentes_pessoas_ids: [],
            },
          ],
        });
        await gravar('leitura', { fim: new Date().toISOString() });
        expect((await f()).encaminhada).toBe(true);
        await gravar('decidir', { resultado: 'APROVADA', evidencia: 'Ata lida e aprovada em sessão.' });
        const anterior = await f();
        const reabrir = {
          mesa_id: mesa,
          versao_id: v.id,
          idempotencia: randomUUID(),
          expira_em: new Date(Date.now() + 3600000).toISOString(),
          reabrir_revisao: anterior.revisao,
        };
        const nova = (
          await chamada(presidenteDaMesa, 'post', rota + '/presidencia/conceder')
            .send(reabrir)
            .expect(201)
        ).body.id;
        expect(
          (
            await chamada(presidenteDaMesa, 'post', rota + '/presidencia/conceder')
              .send(reabrir)
              .expect(201)
          ).body.id,
        ).toBe(nova);
        await ficha(id, cookie).expect(403);
        id = nova;
        cookie = await ativar(id);
        expect((await f()).decisao).toBeNull();
        await gravar('leitura', { fim: anterior.fim });
        if (navegador) await navegador.registrarDecisao(id, cookie);
        else await gravar('decidir', { resultado: 'APROVADA', evidencia: 'Revisão lida e aprovada.' });
        const decisao = await db.deliberacao_ata.findFirstOrThrow({
          where: { versao_id: v.id },
          orderBy: { criado_em: 'desc' },
        });
        expect(decisao.acesso_assembleia_id).toBe(id);
        if (institucional) expect(decisao.conferencia_votacao).toMatchObject({ votantes_presentes: [pSecretario], minimo: 1 });
        const cmd = {
          autoridade: 'Conselho',
          evidencia: 'Conferência',
          idempotencia: randomUUID(),
          revisao: (await f()).revisao,
          modalidade: 'ELETRONICA',
        };
        await chamada(instalador, 'post', 'documentos/' + d.id + '/aprovar')
          .send(cmd)
          .expect(201);
        await ficha(id, cookie).expect(403);
        await assinarEExpedir(
          instalador,
          d.id,
          [{ pessoa: guest.id }, { pessoa: pessoaPresidente, usuario: presidenteDaMesa }],
          tokenAssinatura,
        );
        expect(
          (
            await chamada(
              presidente,
              'get',
              'documentos/' + convocacao + '/assinaturas/' + expedida.versao + '/arquivos/final',
            ).expect(200)
          ).body,
        ).toEqual(expedida.final);
        expect(
          (
            await db.presidencia_conselho.findFirstOrThrow({
              where: { igreja_id: igreja, fim: null },
              include: { oficial: true },
            })
          ).oficial.pessoa_id,
        ).toBe(pPastor);
        await db.competencia_secretaria.update({ where: { id: comp.id }, data: { fim: new Date(dia) } });
      } finally {
        email.mockRestore();
        convites.mockRestore();
        assinaturas.mockRestore();
        if (antigo === undefined) delete process.env.FEATURE_SECRETARIA_ASSINATURAS;
        else process.env.FEATURE_SECRETARIA_ASSINATURAS = antigo;
      }
    },
    60000,
  );

  it('exige emissores e rejeita cargo estranho ao contexto', async () => {
    await publicar('OUTRO', 'CONVOCACAO', [], [cargo]).expect(400);
    await publicar('OUTRO', 'CONVOCACAO', [randomUUID()], []).expect(400);
    const opcoes = (await chamada(secretario, 'get', 'contextos/' + contexto + '/papeis-modelo').expect(200)).body;
    expect(opcoes.map((p: {id: string}) => p.id)).toEqual(expect.arrayContaining([cargo, 'PRESIDENCIA_CONSELHO', 'SECRETARIO_MESA', 'PRESIDENTE_MESA']));
  });

  it('prepara o termo do Conselho com secretário e presidente vigentes, sem gravar até a confirmação', async () => {
    const flag = process.env.FEATURE_SECRETARIA_LIVROS;
    const assinaturas = process.env.FEATURE_SECRETARIA_ASSINATURAS;
    process.env.FEATURE_SECRETARIA_ASSINATURAS = 'true';
    process.env.FEATURE_SECRETARIA_LIVROS = 'true';
    try {
      const c = await db.contexto_secretaria.findUniqueOrThrow({ where: { id: contextoConselho } });
      const contaComum = async (selecionada: boolean) => {
        const u = await db.usuarios.create({ data: { igreja_id: igreja, perfil: 'COMUM', pessoa_id: pSecretario, conta_atuacao: selecionada,
          nome_usuario: 'Conta operacional', email_login: randomUUID() + '@example.invalid', senha_hash: 'inutilizavel' } });
        cookies.set(u.id, 'provisao_session=' + await app.get(SessionService).create(u.id, igreja, 0));
        return u.id;
      };
      const operacional = await contaComum(true), alternativa = await contaComum(false);
      expect((await chamada(operacional, 'get', 'contextos').expect(200)).body.map(c => c.id)).toEqual(expect.arrayContaining([c.id, contexto]));
      const contextosAlternativa = (await chamada(alternativa, 'get', 'contextos').expect(200)).body;
      expect(contextosAlternativa.map(c => c.id).sort()).toEqual([c.id, contexto].sort());
      for (const contextoLeitura of contextosAlternativa)
        expect(contextoLeitura).toMatchObject({ somente_atas: true, pode_preparar: false, pode_aprovar: false });
      const modelosAssembleia = await chamada(operacional,'get','modelos?contexto='+contexto).expect(200);
      expect(modelosAssembleia.body.some(m => m.permissoes.criar)).toBe(false);
      const livro = (await chamada(secretario, 'post','livros').send({ contexto_id:c.id, serie:'ATA_PADRAO', numero:7, modalidade:'PARA_ENCADERNACAO',
        perfil:'CONCILIO_IPB_2025', capacidade_folhas:50, faces_por_folha:2, reserva_exame:2, fonte_normativa:'Manual', restrito:false, idempotencia:randomUUID() }).expect(201)).body;
      const campos = await db.campo_secretaria.findMany({where:{igreja_id:igreja,codigo:{in:['NUMERO_LIVRO','NOME_SECRETARIO_LIVRO','NOME_PREPARADOR']}}});
      const modelo = (await chamada(secretario,'post','modelos').send({ contexto_id:c.id, publicar:true, nome:'Abertura do livro do Conselho', tipo:'OUTRO',
        finalidade:'TERMO_ABERTURA', idempotencia:randomUUID(), configuracao:{...base, contexto:'ORGAO', tipos_orgao:['CONSELHO'], constituicoes:['OFICIAL'],
          estrutura_padrao:{cabecalho:[],corpo:[{tipo:'TEXTO',texto:'Livro {{NUMERO_LIVRO}}. Secretário responsável: {{NOME_SECRETARIO_LIVRO}}.',alinhamento:'ESQUERDA',estilo:'NORMAL'}],rodape:[]},
          papeis_obrigatorios:['SECRETARIO'], obrigatorios_biblioteca:campos.map(p=>p.id), atuacao:{criar:[cargo],preparar:['PRESIDENCIA_CONSELHO'],assinar:[cargo]}} }).expect(201)).body;
      await navegador?.prepararTermo(c.id, cookies.get(operacional)!);
      const rota = 'livros/'+livro.id+'/previa-abertura';
      const pedido = { modelo_versao_id:modelo.versao_id, acao:'preparar', data:dia };
      await chamada(presidente,'post',rota).send({...pedido,acao:'criar'}).expect(403);
      const semTitular = (await chamada(presidente,'post',rota).send({...pedido,data:'2024-12-01'}).expect(201)).body;
      expect(semTitular).toMatchObject({secretario:null,presidente:null});
      expect(semTitular.pendencias).toHaveLength(2);
      await chamada(alternativa,'post',rota).send({...pedido,acao:'criar'}).expect(404);
      await chamada(operacional,'post',rota).send(pedido).expect(403);
      const propria = (await chamada(operacional,'post',rota).send({...pedido,acao:'criar'}).expect(201)).body;
      const opcoes = (await chamada(operacional,'get','modelos?contexto='+c.id).expect(200)).body;
      expect(opcoes.find(m => m.id === modelo.id).permissoes).toEqual({criar:true,preparar:false});
      expect(propria.secretario.pessoa_id).toBe(propria.preparador.pessoa_id);
      const previa = (await chamada(presidente,'post',rota).send(pedido).expect(201)).body;
      expect(previa).toMatchObject({ preparador:{pessoa_id:pPastor}, secretario:{pessoa_id:pSecretario}, presidente:{pessoa_id:pPastor}, pendencias:[] });
      expect(previa.versao.conteudo.arrolados).toEqual(expect.arrayContaining([
        expect.objectContaining({pessoa_id:pSecretario, papeis:['SECRETARIO'], obrigatorio:true}),
        expect.objectContaining({pessoa_id:pPastor, papeis:['PRESIDENTE'], obrigatorio:true})]));
      for (const campo of campos) {
        const valorEsperado = campo.codigo === 'NUMERO_LIVRO' ? 7 : campo.codigo === 'NOME_PREPARADOR' ? previa.preparador.nome : previa.secretario.nome;
        expect(previa.versao.conteudo.valores[campo.id].valor).toBe(valorEsperado);
      }
      expect(await db.documento_versao.count({where:{livro_id:livro.id}})).toBe(0);
      const versao = {...propria.versao,conteudo:{...propria.versao.conteudo,teor:'Abertura confirmada'}};
      const idempotencia = randomUUID();
      const gravar = (conferencia: string) => chamada(operacional,'post','documentos').send({contexto_id:c.id,acao:'criar',restrito:false,conferencia_abertura:conferencia,idempotencia,versao});
      await db.livro_atas.update({where:{id:livro.id},data:{revisao:{increment:1}}});
      await gravar(propria.conferencia).expect(409);
      const atualizada = (await chamada(operacional,'post',rota).send({...pedido,acao:'criar'}).expect(201)).body;
      const doc = (await gravar(atualizada.conferencia).expect(201)).body;
      const salvo = (await chamada(presidente,'get','documentos/'+doc.id).expect(200)).body.versoes[0];
      expect(salvo.conteudo.valores).toEqual(atualizada.versao.conteudo.valores);
      expect(salvo.conteudo.campos).toEqual(atualizada.versao.conteudo.campos);
      expect((await chamada(presidente,'get','livros/'+livro.id).expect(200)).body.estado).toBe('EM_PREPARACAO');
      await chamada(presidente,'post',rota).send(pedido).expect(409);
      await db.competencia_secretaria.create({ data:{ igreja_id:igreja, contexto_id:c.id, usuario_id:presidente, pessoa_id:pPastor,
        registrado_por_id:secretario, inicio, pode_aprovar:true, pode_deliberar:false, pode_consultar_restritos:false, autoridade:'Conselho', evidencia:'Teste' } });
      const rotaDoc = 'documentos/'+doc.id;
      const cmd = (revisao:number) => ({revisao, idempotencia:randomUUID(), autoridade:'Secretaria', evidencia:'Teste'});
      await chamada(operacional,'post',rotaDoc+'/aprovar').send({ ...cmd(1), modalidade: 'ELETRONICA' }).expect(403);
      await chamada(operacional,'post',rotaDoc+'/encaminhar').send(cmd(1)).expect(201);
      await db.usuarios.update({where:{id:operacional},data:{conta_atuacao:false}});
      await gravar(atualizada.conferencia).expect(404);
      await chamada(operacional,'get',rotaDoc).expect(404);
      const worker = app.get(RascunhosService);
      async function concluirRenderizacao(id: string) {
        for (let i = 0; i < 30; i++) {
          if ((await db.trabalho_renderizacao.findUniqueOrThrow({where:{id}})).estado === 'CONCLUIDO') return;
          await worker.executarUm();
        }
        throw new Error('Renderização não concluída');
      }
      const medicao = await chamada(presidente,'post',rotaDoc+'/medicao-livro').send({revisao:2}).expect(201);
      await concluirRenderizacao(medicao.body.id);
      await chamada(presidente,'post',rotaDoc+'/aprovar').send({...cmd(2),modalidade:'FISICA'}).expect(201);
      const matriz = await db.trabalho_renderizacao.findFirstOrThrow({where:{versao_id:salvo.id, finalidade:'MATRIZ_APROVADA'}});
      await concluirRenderizacao(matriz.id);
      const ass = (await chamada(presidente,'get',rotaDoc).expect(200)).body;
      const lote = {versao_id:salvo.id, revisao:ass.revisao};
      await chamada(presidente,'post',rotaDoc+'/assinaturas/via').send({...lote,idempotencia:randomUUID()}).expect(201);
      const via = (await chamada(presidente,'get',rotaDoc+'/assinaturas/'+salvo.id+'/arquivos/via').expect(200)).body;
      const textoPdf = execFileSync('pdftotext',['-layout','-','-'],{input:via,encoding:'utf8'}).replace(/\s+/g,' ');
      expect(textoPdf).toContain('Livro 7.');
      expect(textoPdf).toContain(previa.secretario.nome);
      const scan = await PDFDocument.load(via);
      scan.getPages().at(-1)!.drawText('Conferencia de teste',{x:80,y:45});
      const arquivo = Buffer.from(await scan.save());
      const conferencia = JSON.stringify({...lote,idempotencia:randomUUID(),via_sha256:createHash('sha256').update(via).digest('hex'),evidencia:'Teste',
        assinaturas:ass.versoes[0].arrolados.map((p:{id:string}) => ({arrolado_id:p.id,data:dia,evidencia:'Conferida'}))});
      const conferir = () => chamada(presidente,'post',rotaDoc+'/assinaturas/fisica/conferir').field('dados',conferencia).attach('file',arquivo,'via.pdf');
      await conferir().expect(201);
      for (let i=0;i<20 && (await db.documento.findUniqueOrThrow({where:{id:doc.id}})).estado !== 'EXPEDIDO';i++) await app.get(ExpedicaoWorkerService).executarUm();
      await conferir().expect(201);
      expect((await chamada(presidente,'get','livros/'+livro.id).expect(200)).body).toMatchObject({estado:'ABERTO',registros:[{natureza:'ABERTURA',estado:'EFETIVADO'}]});
      const lista = await chamada(secretario,'get','livros?contexto='+c.id+'&estado=ABERTO&serie=ATA_PADRAO&restrito=false').expect(200);
      expect(lista.body.map((l:{id:string})=>l.id)).toContain(livro.id);
    } finally {
      if (assinaturas === undefined) delete process.env.FEATURE_SECRETARIA_ASSINATURAS; else process.env.FEATURE_SECRETARIA_ASSINATURAS = assinaturas;
      if (flag === undefined) delete process.env.FEATURE_SECRETARIA_LIVROS; else process.env.FEATURE_SECRETARIA_LIVROS = flag;
    }
  });
  it('expede edital e ata da Junta com os titulares vigentes e recusa mandato vencido ou atuação no Conselho', async () => {
    const flag = process.env.FEATURE_SECRETARIA_ASSINATURAS;
    process.env.FEATURE_SECRETARIA_ASSINATURAS = 'true';
    const fila = jest.spyOn(app.get(OutboxService), 'enqueueSignature');
    try {
      const orgao = await db.orgao_interno.create({
        data: {
          igreja_id: igreja,
          tipo: 'JUNTA',
          constituicao: 'OFICIAL',
          nome: 'Junta Diaconal',
          finalidade: 'Diaconia',
          data_criacao: inicio,
          criador_id: secretario,
        },
      });
      const junta = await db.contexto_secretaria.create({
        data: { igreja_id: igreja, orgao_id: orgao.id, tipo: 'ORGAO', nome: orgao.nome, sigla: 'JD' },
      });
      async function eleger(codigo: string, nome: string) {
        const titular = await operador(nome);
        const cargoDaJunta = await db.cargo_orgao.create({
          data: { igreja_id: igreja, orgao_id: orgao.id, codigo, nome, funcao: codigo },
        });
        const oficial = await db.oficial.create({
          data: { igreja_id: igreja, pessoa_id: titular.pessoa, tipo: 'DIACONO' },
        });
        await db.eventos_membresia.create({
          data: {
            igreja_id: igreja,
            pessoa_id: titular.pessoa,
            data_evento: inicio,
            tipo_evento: 'ADMISSAO',
            rol: 'COMUNGANTES',
            motivacao_evento: 'PROFISSAO_DE_FE',
          },
        });
        await db.evento_oficial.create({
          data: {
            igreja_id: igreja,
            oficial_id: oficial.id,
            tipo: 'ORDENACAO',
            data_efeito: inicio,
            ordem: 1,
            autoridade: 'Conselho',
            evidencia: 'Ata',
          },
        });
        const mandato = await db.mandato_oficial.create({
          data: {
            igreja_id: igreja,
            oficial_id: oficial.id,
            data_eleicao: inicio,
            data_posse: inicio,
            termino_previsto: new Date('2029-12-31'),
            autoridade: 'Assembleia',
            evidencia: 'Ata',
            avaliacao_eleicao: {},
          },
        });
        const ano = Number(dia.slice(0, 4));
        await db.ocupacao_cargo.create({
          data: {
            igreja_id: igreja,
            orgao_id: orgao.id,
            cargo_id: cargoDaJunta.id,
            pessoa_id: titular.pessoa,
            inicio: new Date(ano + '-01-01'),
            termino_previsto: new Date(ano + '-12-31'),
          },
        });
        return { ...titular, cargo: cargoDaJunta.id, mandato: mandato.id };
      }
      const lider = await eleger('PRESIDENTE', 'Presidente da Junta');
      const escrivao = await eleger('SECRETARIO', 'Secretário da Junta');
      const emitirModelo = (tipo: string, finalidade: string, titular: string, extras: object = {}) =>
        chamada(secretario, 'post', 'modelos').send({
          contexto_id: junta.id,
          tipo,
          nome: finalidade + ' da Junta',
          finalidade,
          publicar: true,
          idempotencia: randomUUID(),
          configuracao: {
            ...base,
            contexto: 'ORGAO',
            tipos_orgao: ['JUNTA'],
            constituicoes: ['OFICIAL'],
            atuacao: { criar: [titular], preparar: [], assinar: [] },
            ...extras,
          },
        });
      const editalModelo = (
        await emitirModelo('OUTRO', 'CONVOCACAO', lider.cargo, { vinculo_reuniao: 'OBRIGATORIO' }).expect(201)
      ).body;
      const ataModelo = (await emitirModelo('ATA', 'ATA_REUNIAO', escrivao.cargo).expect(201)).body;
      const local = await db.local_reuniao.create({ data: { igreja_id: igreja, descritivo: 'Salão da Junta' } });
      const dados = {
        restrito: false,
        modalidade: 'REGULAR',
        situacao: 'AGENDADA',
        data: dia,
        horario_previsto: '18:00',
        itens_pauta: [{ descricao: 'Visitas aos membros', proponente_id: lider.pessoa }],
      };
      const evento = (
        await chamada(lider.usuario, 'post', 'reunioes')
          .send({ contexto_id: junta.id, local_id: local.id, dados, idempotencia: randomUUID() })
          .expect(201)
      ).body.id;
      const mesa = [lider, escrivao].map((t, i) => ({
        pessoa_id: t.pessoa,
        papeis: [i === 0 ? 'PRESIDENTE' : 'SECRETARIO'],
        assina: true,
        obrigatorio: true,
        responsavel: i === 0,
        fundamento: 'Mesa em exercício',
      }));
      const documento = (u: string, modelo: string, ata: boolean) => {
        const versao = entrada(modelo, evento);
        return chamada(u, 'post', 'documentos').send({
          contexto_id: junta.id,
          restrito: false,
          idempotencia: randomUUID(),
          versao: {
            ...versao,
            assunto: ata ? 'Ata da Junta Diaconal' : 'Convocação da Junta Diaconal',
            conteudo: {
              ...versao.conteudo,
              arrolados: ata ? mesa : [mesa[0]],
              ...(ata && { redator_ata: { pessoa_id: escrivao.pessoa } }),
            },
          },
        });
      };
      await documento(escrivao.usuario, editalModelo.versao_id, false).expect(403);
      await documento(presidente, editalModelo.versao_id, false).expect(403);
      const orgaoConselho = (await db.cargo_orgao.findUniqueOrThrow({ where: { id: cargo } })).orgao_id;
      const conselho =
        (await db.contexto_secretaria.findFirst({ where: { orgao_id: orgaoConselho } })) ??
        (await db.contexto_secretaria.create({
          data: { igreja_id: igreja, tipo: 'ORGAO', orgao_id: orgaoConselho, nome: 'Conselho', sigla: 'CONS' },
        }));
      await chamada(lider.usuario, 'post', 'reunioes')
        .send({ contexto_id: conselho.id, local_id: local.id, dados, idempotencia: randomUUID() })
        .expect(403);
      await db.competencia_secretaria.create({
        data: {
          igreja_id: igreja,
          contexto_id: junta.id,
          usuario_id: lider.usuario,
          pessoa_id: lider.pessoa,
          registrado_por_id: secretario,
          inicio,
          pode_aprovar: true,
          pode_deliberar: true,
          pode_consultar_restritos: false,
          autoridade: 'Junta',
          evidencia: 'Delegação',
        },
      });
      const token = (id: string) => fila.mock.calls.find((c) => c[1] === id)![2];
      const ato = (revisao: number) => ({
        revisao,
        idempotencia: randomUUID(),
        autoridade: 'Junta',
        evidencia: 'Conferência da mesa',
      });
      let signatarioComum: { pessoa: string; usuario: string };
      const expedir = async (id: string, ata: boolean) => {
        const rota = 'documentos/' + id;
        await chamada(ata ? escrivao.usuario : lider.usuario, 'post', rota + '/encaminhar')
          .send(ato(1))
          .expect(201);
        if (ata)
          await chamada(lider.usuario, 'post', rota + '/deliberar')
            .send({ ...ato(2), reuniao_id: evento, resultado: 'APROVADA', data: dia })
            .expect(201);
        await chamada(lider.usuario, 'post', rota + '/aprovar')
          .send({ ...ato(ata ? 3 : 2), modalidade: 'ELETRONICA' })
          .expect(201);
        return assinarEExpedir(lider.usuario, id, ata ? [signatarioComum, lider] : [lider], token);
      };
      const edital = (await documento(lider.usuario, editalModelo.versao_id, false).expect(201)).body.id;
      await expedir(edital, false);
      const ficha = (await chamada(escrivao.usuario, 'get', 'reunioes/' + evento).expect(200)).body;
      await chamada(escrivao.usuario, 'patch', 'reunioes/' + evento)
        .send({
          revisao: ficha.revisao,
          local_id: local.id,
          idempotencia: randomUUID(),
          dados: {
            ...dados,
            situacao: 'ENCERRADA',
            inicio: dia + 'T18:00:00Z',
            fim: dia + 'T19:00:00Z',
            itens_pauta: [{ ...dados.itens_pauta[0], id: ficha.itens_pauta[0].id }],
            competencia: 'Junta',
            participantes: mesa.map((p) => ({ pessoa_id: p.pessoa_id, presente: true, papeis: p.papeis })),
            universo_informado: 2,
            quorum_minimo: 2,
            quorum_conferido: true,
            fundamento_quorum: 'Dois presentes',
            resultado: 'Aprovado',
          },
        })
        .expect(200);
      await navegador?.consultarJunta(junta.id, cookies.get(lider.usuario)!, 'presidente');
      await navegador?.consultarJunta(junta.id, cookies.get(escrivao.usuario)!, 'secretario');
      const ata = (await documento(escrivao.usuario, ataModelo.versao_id, true).expect(201)).body.id;
      const { email_login } = await db.usuarios.update({ where: { id: escrivao.usuario },
        data: { email_login: randomUUID() + '@example.invalid' }, select: { email_login: true } });
      const emailIndividual = (await db.pessoas.findUniqueOrThrow({where:{id:escrivao.pessoa}})).email!;
      expect(emailIndividual).not.toBe(email_login);
      const u = await db.usuarios.create({ data: { igreja_id: igreja, pessoa_id: escrivao.pessoa, perfil: 'COMUM', conta_atuacao: true,
        email_login: emailIndividual, nome_usuario: 'Secretário da Junta', senha_hash: 'inutilizavel' } });
      cookies.set(u.id, 'provisao_session=' + await app.get(SessionService).create(u.id, igreja, 0));
      signatarioComum = { pessoa: escrivao.pessoa, usuario: u.id };
      await chamada(u.id,'get','modelos?contexto='+junta.id).expect(200);
      await chamada(u.id,'get','reunioes/'+reuniao).expect(404);
      await expedir(ata, true);
      const ontem = new Date(Date.parse(dia) - 86400000);
      await db.mandato_oficial.update({ where: { id: escrivao.mandato }, data: { termino_previsto: ontem } });
      await documento(escrivao.usuario, ataModelo.versao_id, true).expect(403);
      await documento(u.id, ataModelo.versao_id, true).expect(404);
    } finally {
      fila.mockRestore();
      if (flag === undefined) delete process.env.FEATURE_SECRETARIA_ASSINATURAS;
      else process.env.FEATURE_SECRETARIA_ASSINATURAS = flag;
    }
  }, 60000);

  it('separa presidência, preparação, assinatura, mandato encerrado e modelo em edição', async () => {
    const edital = (await publicar('OUTRO', 'CONVOCACAO', ['PRESIDENCIA_CONSELHO'], [], ['PRESIDENCIA_CONSELHO']).expect(201)).body;
    const ata = (await publicar('ATA', 'ATA_AGO', ['SECRETARIO_MESA'], [cargo], ['SECRETARIO_MESA','PRESIDENTE_MESA']).expect(201)).body;
    const listar = async () => (await chamada(secretario, 'get', 'modelos?contexto=' + contexto).expect(200)).body as {id: string;permissoes: {criar: boolean; preparar: boolean}}[];
    expect((await listar()).find(m => m.id === ata.id)?.permissoes).toEqual({ criar: false, preparar: true });
    expect((await listar()).find(m => m.id === edital.id)?.permissoes).toEqual({ criar: false, preparar: false });
    await criar(secretario, edital.versao_id, null).expect(403);
    await criar(secretario, edital.versao_id, null, 'preparar').expect(403);
    const doc = (await criar(presidente, edital.versao_id, null).expect(201)).body;
    const ficha = (await chamada(presidente, 'get', 'documentos/' + doc.id).expect(200)).body;
    expect(ficha.tramitacao.pendencias).toEqual(expect.arrayContaining([expect.objectContaining({ destino: 'arrolados', mensagem: expect.stringContaining('Presidente institucional') })]));
    const minuta = (await criar(secretario, ata.versao_id, reuniao, 'preparar').expect(201)).body;
    await chamada(secretario,'post','documentos/' + minuta.id + '/encaminhar').send({ revisao: 1, autoridade:'Secretário', evidencia:'Ato', idempotencia:randomUUID() }).expect(403);
    await chamada(presidente, 'post', 'modelos/' + edital.id + '/editar').send({ revisao: 1, idempotencia: randomUUID() }).expect(201);
    await criar(presidente, edital.versao_id, null).expect(409);
    const primeiroCargo = await db.cargo_orgao.findUniqueOrThrow({ where: { id: cargo } });
    const gestao = (u: string, verbo: 'get' | 'post' | 'patch', rota: string) => request(app.getHttpServer())[verbo]('/orgaos/gestao/' + primeiroCargo.orgao_id + rota)
      .set('Cookie', cookies.get(u)!).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    const prova = { versao_id: ataCargo, trecho: 'Item que comprova o ato' };
    await gestao(presidente, 'patch', '/ocupacoes/' + ocupacao + '/encerrar-oficial').send({ data_efeito: dia,
      idempotencia: randomUUID(), autoridade: 'Conselho', evidencia: 'Ata', motivo: 'Fim da ocupação', comprovacao: prova }).expect(200);
    expect((await listar()).find(m => m.id === ata.id)?.permissoes.preparar).toBe(false);
    await criar(secretario, ata.versao_id, reuniao, 'preparar').expect(403);

    const amanha = new Date(+new Date(dia) + 86400000).toISOString().slice(0,10);
    const candidatos = await gestao(presidente, 'get', '/cargos/' + cargo + '/candidatos').query({ eleicao: dia, posse: amanha }).expect(200);
    expect(candidatos.body).toContainEqual(expect.objectContaining({id:pSecretario,limite_exercicio:'2029-12-31'}));
    const sucessao = await gestao(presidente, 'post', '/cargos/' + cargo + '/eleicao-oficial').send({ pessoa_id: pSecretario,
      data_eleicao: dia, data_posse: amanha, termino_previsto: '2029-12-31', idempotencia: randomUUID(), autoridade: 'Conselho', evidencia: 'Ata',
      comprovacao: { eleicao: prova, posse: prova, sucede_id: ocupacao } }).expect(201);
    expect(await db.ato_orgao.findUniqueOrThrow({ where:{id:sucessao.body.ato_id}, select:{detalhes:true} })).toMatchObject({ detalhes:{continuidade:'REELEICAO',sucede_id:ocupacao} });
    await criar(secretario, ata.versao_id, reuniao, 'preparar').expect(403);
  });

  it('aceita a assinatura do segundo secretário pelo primeiro somente com substituição expressa no modelo', async () => {
    const primeiro = await db.cargo_orgao.findUniqueOrThrow({ where: { id: cargo } });
    const segundo = await db.cargo_orgao.findFirstOrThrow({ where: { igreja_id: igreja, orgao_id: primeiro.orgao_id, codigo: 'SEGUNDO_SECRETARIO' } });
    // O segundo secretário ocupa a vaga até a posse da sucessão programada no dia seguinte.
    await db.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: primeiro.orgao_id, pessoa_id: pSecretario, cargo_id: segundo.id, inicio: new Date(dia), inicio_ordem: 3, termino_previsto: new Date(dia) } });
    for (const permitir of [false, true]) {
      const regra = { criar: ['PRESIDENCIA_CONSELHO'], preparar: [], assinar: [cargo],
        ...(permitir && { substituicao_assinatura: { titular: cargo, substituto: segundo.id } }) };
      const modelo = await chamada(secretario, 'post', 'modelos').send({ publicar: true, idempotencia: randomUUID(), nome: 'Ofício', contexto_id: contexto, tipo: 'OUTRO', finalidade: 'OFICIO', configuracao: { ...base, atuacao: regra } }).expect(201);
      const v = entrada(modelo.body.versao_id, null);
      const doc = await chamada(presidente, 'post', 'documentos').send({ contexto_id: contexto, restrito: false, idempotencia: randomUUID(), versao: { ...v, conteudo: { ...v.conteudo, arrolados: [{ pessoa_id: pSecretario, papeis: ['SECRETARIO'], assina: true, obrigatorio: true, responsavel: true, fundamento: 'Assinatura da secretaria' }] } } }).expect(201);
      const ficha = await chamada(presidente, 'get', 'documentos/' + doc.body.id).expect(200);
      expect(ficha.body.tramitacao.pendencias.some((p: {mensagem: string}) => p.mensagem.includes('Falta assinatura obrigatória do titular'))).toBe(!permitir);
    }
  });
  it('agenda e abre o edital uma vez, confere alterações, expede, recepciona a pauta e reconvoca', async () => {
    const antes = process.env.FEATURE_SECRETARIA_ASSINATURAS;
    process.env.FEATURE_SECRETARIA_ASSINATURAS = 'true';
    try {
      const http = (verbo: 'get' | 'post' | 'patch', rota: string) => chamada(presidente, verbo, rota);
      const cmd = (revisao: number) => ({ idempotencia: randomUUID(), revisao, autoridade: 'Presidência', evidencia: 'Conferência do teste' });
      const biblioteca = (await http('get','campos').expect(200)).body as {codigo:string; id:string}[];
      const campo = (codigo: string) => biblioteca.find(c => c.codigo === codigo)!.id;
      const fontes = ['DATA_PREVISTA_REUNIAO','HORARIO_PREVISTO_REUNIAO_POR_EXTENSO','LOCAL_REUNIAO','PAUTA_REUNIAO','NOME_CONVOCANTE','NOME_PREPARADOR','OBSERVACOES'];
      const espaco = { superior: 0, inferior: 0 };
      const composicao = { versao_formato: 1, pagina: { papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12, margens_cm: { superior: 2, inferior: 2, esquerda: 2, direita: 2 }, espacamento_cm: { cabecalho: espaco, corpo: espaco, rodape: espaco } }, cabecalho: [], rodape: [], notas: {},
        corpo: fontes.map(c => ({ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'campo', campo_id: campo(c), apresentacao: c === 'PAUTA_REUNIAO' ? 'lista_numerada' : 'individual' }] })) };
      const modelo = (await http('post','modelos').send({ contexto_id: contexto, nome: 'Edital com pauta', finalidade:'CONVOCACAO', tipo:'OUTRO', publicar:true, idempotencia:randomUUID(), configuracao: { ...base, vinculo_reuniao:'OBRIGATORIO', composicao_padrao: composicao, atuacao:{criar:['PRESIDENCIA_CONSELHO'],preparar:[],assinar:[]} } }).expect(201)).body;
      const local = await db.local_reuniao.create({data:{igreja_id:igreja, descritivo:'Salão do Conselho'}});
      const futura = new Date(Date.now() + 7 * 86400000).toISOString().slice(0,10);
      const agenda = { local_id: local.id, dados:{ situacao:'AGENDADA', restrito:false, modalidade:'AGO', data:futura, horario_previsto:'19:30', itens_pauta:[{descricao:'Orçamento', proponente_id:null},{descricao:'Visitas',proponente_id:null}] } };
      const nota = { tipo:'texto', multiplo:false, origem:{tipo:'manual'}, ajustado_manualmente:true, valor:'Observação conservada' };
      const versao = { ...entrada(modelo.versao_id,null), conteudo: { teor:'',campos:{}, anexos:[], valores:{[campo('OBSERVACOES')]:nota}, arrolados:[{ pessoa_id:pPastor, papeis:['PRESIDENTE'], assina:true, obrigatorio:true, responsavel:true, fundamento:'Presidência' }] } };
      const pedido = { contexto_id:contexto, restrito:false, idempotencia:randomUUID(), retomar_convocacao:true, agendamento:agenda, versao };
      const total = await db.reuniao.count({where:{contexto_id:contexto}});
      await http('post','documentos').send({...pedido, versao:{...versao, modelo_versao_id:randomUUID()}}).expect(400);
      expect(await db.reuniao.count({where:{contexto_id:contexto}})).toBe(total);
      const [{body: documento},{body: repetido}] = await Promise.all([http('post','documentos').send(pedido).expect(201),http('post','documentos').send(pedido).expect(201)]);
      expect(repetido.id).toBe(documento.id);
      expect(await db.reuniao.count({where:{contexto_id:contexto}})).toBe(total+1);
      const rota = 'documentos/'+documento.id;
      const ler = async () => (await http('get',rota).expect(200)).body;
      const inicial = (await ler()).versoes[0];
      const id = inicial.reuniao_id, valores = inicial.conteudo.valores;
      expect(valores[campo('DATA_PREVISTA_REUNIAO')]).toMatchObject({valor:futura,origem:{cadastro:'reuniao',registro_id:id,revisao:1}});
      expect(valores[campo('HORARIO_PREVISTO_REUNIAO_POR_EXTENSO')].valor).toBe('dezenove horas e trinta minutos');
      expect(valores[campo('LOCAL_REUNIAO')].valor).toBe('Salão do Conselho');
      expect(valores[campo('NOME_CONVOCANTE')].origem.registro_id).toBe(pPastor);
      expect(valores[campo('PAUTA_REUNIAO')].valor).toEqual(['Orçamento','Visitas']);
      const pelaFicha = () => http('post','documentos').send({ ...pedido, agendamento:undefined, idempotencia:randomUUID(), versao:{...versao,reuniao_id:id} });
      expect((await pelaFicha().expect(201)).body.id).toBe(documento.id);
      const reuniaoRota = 'reunioes/'+id;
      const ficha = (await http('get',reuniaoRota).expect(200)).body;
      expect(ficha.convocacao_em_curso).toMatchObject({documento_id:documento.id, pode_editar:true});
      const pauta = ficha.itens_pauta.map((p: {id:string;descricao:string}) => ({ id:p.id, descricao:p.descricao, proponente_id:null }));
      pauta[1].descricao = 'Visitas pastorais';
      await http('patch',reuniaoRota).send({ revisao:1,idempotencia:randomUUID(),local_id:local.id,dados:{...agenda.dados,itens_pauta:pauta} }).expect(200);
      const conferir = { ...versao, reuniao_id:id, conteudo:inicial.conteudo };
      await http('post',rota+'/encaminhar').send(cmd(1)).expect(409);
      const previa = (await http('post',rota+'/previa-fontes').send({revisao:1,versao:conferir}).expect(201)).body;
      expect(previa.valores[campo('PAUTA_REUNIAO')].valor).toEqual(['Orçamento','Visitas pastorais']);
      expect((await ler()).versoes[0].conteudo.valores[campo('PAUTA_REUNIAO')].valor[1]).toBe('Visitas');
      await http('patch',rota).send({revisao:1,idempotencia:randomUUID(),versao:{...conferir,atualizar_fontes:previa.assinatura}}).expect(200);
      expect((await ler()).versoes[0].conteudo.valores[campo('OBSERVACOES')]).toEqual(nota);
      await db.competencia_secretaria.create({data:{igreja_id:igreja, contexto_id:contexto, usuario_id:presidente, pessoa_id:pPastor, registrado_por_id:secretario,inicio, pode_aprovar:true, pode_deliberar:false, pode_consultar_restritos:false, autoridade:'Conselho', evidencia:'Ato'}});
      await http('post',rota+'/encaminhar').send(cmd(2)).expect(201);
      await http('post',rota+'/aprovar').send({...cmd(3),modalidade:'FISICA'}).expect(201);
      const aprovada = await ler();
      const matriz = {versao_id:inicial.id,revisao:aprovada.revisao};
      const worker = app.get(RascunhosService);
      const job = await db.trabalho_renderizacao.findFirstOrThrow({where:{versao_id:inicial.id}});
      for (let n = 0; n < 30 && (await db.trabalho_renderizacao.findUniqueOrThrow({where:{id:job.id}})).estado !== 'CONCLUIDO'; n++) await worker.executarUm();
      await http('post',rota+'/assinaturas/via').send({...matriz,idempotencia:randomUUID()}).expect(201);
      const via = (await http('get',rota+'/assinaturas/'+inicial.id+'/arquivos/via').expect(200)).body;
      const texto = execFileSync('pdftotext',['-layout','-','-'],{input:via,encoding:'utf8'});
      expect(texto).toMatch(/Orçamento[\s\S]+Visitas pastorais/);
      const scan = await PDFDocument.load(via);
      scan.getPages().at(-1)!.drawText('Assinatura de teste',{x:80,y:70});
      await http('post',rota+'/assinaturas/fisica/conferir').field('dados',JSON.stringify({...matriz,idempotencia:randomUUID(),via_sha256:createHash('sha256').update(via).digest('hex'),evidencia:'Teste',assinaturas:[{arrolado_id:aprovada.versoes[0].arrolados[0].id,data:dia,evidencia:'Conferida'}]})).attach('file',Buffer.from(await scan.save()),'via.pdf').expect(201);
      for (let n = 0; n < 20 && (await ler()).estado !== 'EXPEDIDO'; n++) await app.get(ExpedicaoWorkerService).executarUm();
      const expedida = (await http('get',reuniaoRota).expect(200)).body;
      expect(expedida.convocacao_em_curso).toBeNull();
      expect(expedida.convocacoes).toEqual([expect.objectContaining({documento_id:documento.id,agendamento_alterado:false})]);
      const recebida = campo('PAUTA'), horarioEdital = campo('OBSERVACOES'), inicioReal = campo('HORARIO_INICIO_REUNIAO');
      const ata = (await http('post','modelos').send({contexto_id:contexto,nome:'Ata encadeada',tipo:'ATA', finalidade:'ATA_AGO',publicar:true,idempotencia:randomUUID(),configuracao:{...base,atuacao:{criar:['PRESIDENCIA_CONSELHO'],preparar:[],assinar:[]},obrigatorios_biblioteca:[recebida,horarioEdital,inicioReal],antecedentes:[{modelo_id:modelo.id,campos:{[recebida]:campo('PAUTA_REUNIAO'),[horarioEdital]:campo('HORARIO_PREVISTO_REUNIAO_POR_EXTENSO')}}]}}).expect(201)).body;
      const outraReuniao = (await http('post','reunioes').send({...agenda,contexto_id:contexto,idempotencia:randomUUID()}).expect(201)).body.id;
      const consulta = {modelo_destino:ata.versao_id,reuniao_id:id};
      expect((await http('get','motivadores').query(consulta).expect(200)).body.itens.map(x=>x.versao_id)).toEqual([inicial.id]);
      expect((await http('get','motivadores').query({...consulta,reuniao_id:outraReuniao}).expect(200)).body.itens).toEqual([]);
      await http('post','antecedentes/previa').send({modelo_versao_id:ata.versao_id,origem_id:inicial.id,reuniao_id:outraReuniao,restrito:false}).expect(400);
      await http('post','documentos').send({contexto_id:contexto,restrito:false,idempotencia:randomUUID(),versao:{...entrada(ata.versao_id,outraReuniao),data_documento:futura,motivador_id:inicial.id}}).expect(400);
      const {body:minuta} = await http('post','documentos').send({contexto_id:contexto,restrito:false,idempotencia:randomUUID(),versao:{...entrada(ata.versao_id,id),data_documento:futura,motivador_id:inicial.id}}).expect(201);
      expect((await http('get','documentos/'+minuta.id).expect(200)).body.versoes[0].conteudo.valores[recebida]).toMatchObject({valor:['Orçamento','Visitas pastorais'],origem:{tipo:'documento_anterior',versao_id:inicial.id}});
      await http('patch',reuniaoRota).send({revisao:2,idempotencia:randomUUID(),local_id:local.id,dados:{...agenda.dados,horario_previsto:'20:30',itens_pauta:pauta}}).expect(200);
      expect((await http('get',reuniaoRota).expect(200)).body.convocacoes[0].agendamento_alterado).toBe(true);
      expect((await pelaFicha().expect(201)).body.id).not.toBe(documento.id);
      const versaoAta = {...entrada(ata.versao_id,id),data_documento:futura,motivador_id:inicial.id};
      const fichaAta = async () => (await http('get','documentos/'+minuta.id).expect(200)).body.versoes[0];
      const antesDaSessao = await fichaAta();
      expect(antesDaSessao.conteudo.valores[inicioReal].valor).toBeNull();
      const realizada = {...ficha.dados, situacao:'EM_ANDAMENTO', horario_previsto:'20:30', itens_pauta:pauta, inicio:futura+'T21:15:00Z'};
      await http('patch',reuniaoRota).send({revisao:3,idempotencia:randomUUID(),local_id:local.id,dados:realizada}).expect(200);
      const sessao = (await http('get',reuniaoRota).expect(200)).body;
      await http('patch','documentos/'+minuta.id).send({revisao:1,idempotencia:randomUUID(),versao:{...versaoAta,conteudo:antesDaSessao.conteudo}}).expect(200);
      const valoresAta = (await fichaAta()).conteudo.valores;
      expect(valoresAta[horarioEdital]).toMatchObject({valor:'dezenove horas e trinta minutos', origem:{tipo:'documento_anterior', versao_id:inicial.id}});
      expect(valoresAta[inicioReal]).toMatchObject({valor:sessao.horario_inicio_reuniao, origem:{tipo:'sistema',registro_id:id}});
      expect(valoresAta[inicioReal].valor).toMatch(/:15$/);
    } finally {
      if (antes === undefined) delete process.env.FEATURE_SECRETARIA_ASSINATURAS; else process.env.FEATURE_SECRETARIA_ASSINATURAS=antes;
    }
  },60000);

  it('permite ao administrador identificado registrar o próprio cargo com exercício e ata', async () => {
    const { orgao_id } = await db.contexto_secretaria.findUniqueOrThrow({ where: { id: contextoConselho } });
    const pessoa = await db.pessoas.create({ data: { igreja_id: igreja, nome_completo: 'Administrador presbítero', sexo: 'MASCULINO', data_nascimento: inicio } });
    const admin = await db.usuarios.create({ data: { igreja_id: igreja, pessoa_id: pessoa.id, nome_usuario: 'Administrador presbítero',
      perfil: 'ADMINISTRADOR', email_login: randomUUID() + '@example.invalid', senha_hash: 'inutilizavel' } });
    const cookie = 'provisao_session=' + await app.get(SessionService).create(admin.id, igreja, 0);
    const http = (verbo: 'get' | 'post', rota: string) => request(app.getHttpServer())[verbo](rota)
      .set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
    const vaga = await db.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao_id!, codigo: 'TESTE_REGISTRO_ADMIN', nome: 'Secretário adjunto' } });
    const rota = '/orgaos/gestao/' + orgao_id + '/cargos/' + vaga.id;
    const candidatos = () => http('get', rota + '/candidatos').query({ eleicao: dia, posse: dia, pessoa_id: pessoa.id });
    const ficha = () => http('get', '/orgaos/' + orgao_id).query({ data: dia }).expect(200);
    const prova = { versao_id: ataCargo, trecho: 'Item sobre a eleição e a posse' };
    const dados = { pessoa_id: pessoa.id, data_eleicao: dia, data_posse: dia, termino_previsto: dia, autoridade: 'Conselho', evidencia: prova.trecho };
    const registrar = (corpo: object) => http('post', rota + '/eleicao-oficial').send({ ...corpo, idempotencia: randomUUID() });
    const referencia = { versao_id: ataCargo };
    const comprovado = { pessoa_id: pessoa.id, data_eleicao: dia, data_posse: dia, termino_previsto: dia,
      comprovacao: { eleicao: referencia, posse: referencia } };
    expect((await ficha()).body).toMatchObject({ pode_registrar_cargos: true, preparo_registro_cargos: null });
    expect((await candidatos().expect(200)).body).toEqual([]);
    await registrar(comprovado).expect(400);
    await db.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa.id, data_evento: inicio, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE' } });
    const oficial = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoa.id, tipo: 'PRESBITERO_REGENTE' } });
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, tipo: 'ORDENACAO', data_efeito: inicio, ordem: 1, autoridade: 'Concílio', evidencia: 'Ata' } });
    await db.mandato_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, data_eleicao: inicio, data_posse: inicio,
      termino_previsto: new Date('2029-12-31'), autoridade: 'Assembleia', evidencia: 'Ata', avaliacao_eleicao: {} } });
    const [candidato] = (await candidatos().expect(200)).body;
    expect(candidato).toMatchObject({ id: pessoa.id, termino_sugerido: '2029-12-31' });
    comprovado.termino_previsto = candidato.termino_sugerido;
    await registrar(dados).expect(403);
    const registro = (await registrar(comprovado).expect(201)).body;
    const ato = await db.ato_orgao.findFirstOrThrow({ where: { igreja_id: igreja, operador_id: admin.id, tipo: 'ELEICAO_CARGO' } });
    expect(ato.autoridade).toBe((await db.orgao_interno.findUniqueOrThrow({ where: { id: orgao_id! } })).nome);
    expect(ato.detalhes).toMatchObject({ ocupacao_id: registro.ocupacao_id, atribuicao_id: null, origem_autorizacao: 'PERFIL_ADMINISTRADOR', termino_previsto: candidato.termino_sugerido });
    expect(await db.referencia_ata_institucional.count({ where: { igreja_id: igreja, ato_orgao_id: ato.id, versao_id: ataCargo } })).toBe(2);
    await db.usuarios.update({ where: { id: admin.id }, data: { pessoa_id: null } });
    expect((await ficha()).body).toMatchObject({ pode_registrar_cargos: false, preparo_registro_cargos: 'VINCULAR_PESSOA' });
    await candidatos().expect(403);
  });

});
