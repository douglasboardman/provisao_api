import { createHash, randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
import { ConfiguracaoModelo, VersaoInput } from '../src/secretaria/secretaria.dto';
import { RascunhosService } from '../src/secretaria/rascunhos.service';
import { execFileSync } from 'node:child_process';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
integration('E04: secretaria HTTP, transações e integridade PostgreSQL', () => {
  let app: INestApplication, p: PrismaService;
  const igreja = randomUUID(), outra = randomUUID(), admin = randomUUID(), secretario = randomUUID(), gestor = randomUUID(), auditor = randomUUID(), pessoa = randomUUID(), pessoaOutra = randomUUID();
  const cookies: Record<string, string> = {};
  let contexto = '', contextoOutra = '', modeloId = '', modeloVersao = '', reuniao = '', aprovado = '', aprovadoVersao = '';
  const flag = process.env.FEATURE_SECRETARIA;
  const dia = '2026-01-10';
  const config: ConfiguracaoModelo = { perfil: 'ATA_PADRAO', contexto: 'ASSEMBLEIA_GERAL', tipos_orgao: [], constituicoes: [], motivador: 'OPCIONAL', resolucoes: 'OPCIONAL', registro_livro: true, campos_obrigatorios: ['LOCAL'], papeis_obrigatorios: ['PRESIDENTE', 'SECRETARIO'], cargos_obrigatorios: [] };
  const cmd = (revisao: number) => ({ revisao, autoridade: 'Assembleia competente', evidencia: 'Conferência sintética', idempotencia: randomUUID() });
  const post = (path: string, user = 'secretario') => request(app.getHttpServer()).post(`/secretaria/${path}`).set('Cookie', cookies[user]).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  const patch = (path: string, user = 'secretario') => request(app.getHttpServer()).patch(`/secretaria/${path}`).set('Cookie', cookies[user]).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  const get = (path: string, user = 'secretario') => request(app.getHttpServer()).get(`/secretaria/${path}`).set('Cookie', cookies[user]);
  const reuniaoDados = (data = dia) => ({ restrito: false, modalidade: 'AGO', data, local: 'Templo', inicio: null, fim: null, pauta: 'Assuntos sintéticos', competencia: 'Assembleia geral conforme convocação', universo_informado: 1, quorum_minimo: 1, quorum_conferido: true, fundamento_quorum: 'Presença conferida', resultado: 'Pauta examinada', participantes: [{ pessoa_id: pessoa, presente: true, papeis: ['PRESIDENTE', 'SECRETARIO'] }] });
  const versao = (modelo = modeloVersao, r: string | null = reuniao): VersaoInput => ({ modelo_versao_id: modelo, reuniao_id: r, motivador_id: null, assunto: 'Ata sintética', data_documento: dia, conteudo: { teor: 'Teor sintético aprovado.', campos: { LOCAL: 'Templo' }, arrolados: [{ pessoa_id: pessoa, papeis: ['PRESIDENTE', 'SECRETARIO'], cargo_id: null, cargos_ids: [], assina: true, obrigatorio: true, responsavel: true, fundamento: 'Escolha da mesa registrada na reunião' }], anexos: [] } });
  async function criarDoc(v = versao(), restrito = false) {
    return (await post('documentos').send({ contexto_id: contexto, restrito, versao: v, idempotencia: randomUUID() }).expect(201)).body.id as string;
  }
  async function detalhe(id: string) { return (await get(`documentos/${id}`).expect(200)).body; }
  async function deliberar(id: string, r = reuniao) {
    const d = await detalhe(id);
    return post(`documentos/${id}/deliberar`, 'gestor').send({ ...cmd(d.revisao), reuniao_id: r, resultado: 'APROVADA', data: dia }).expect(201);
  }
  async function encaminhar(id: string) { const d = await detalhe(id); return post(`documentos/${id}/encaminhar`).send(cmd(d.revisao)).expect(201); }
  async function aprovar(id: string) { const d = await detalhe(id); return post(`documentos/${id}/aprovar`, 'gestor').send(cmd(d.revisao)).expect(201); }
  async function processarAte(id: string) {
    const worker = app.get(RascunhosService);
    for (let i = 0; i < 40; i++) {
      const job = await p.trabalho_renderizacao.findUniqueOrThrow({ where: { id } });
      if (['CONCLUIDO', 'OBSOLETO', 'FALHOU'].includes(job.estado)) return job;
      if (!await worker.executarUm()) return job;
    }
    throw new Error('A fila de homologação excedeu 40 trabalhos no cenário.');
  }
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.listen(0, '127.0.0.1');
    p = app.get(PrismaService);
    for (const [id, nome] of [[igreja, 'E04 Alfa'], [outra, 'E04 Beta']]) await p.igreja.create({ data: { id, nome } });
    for (const [id, tenant] of [[pessoa, igreja], [pessoaOutra, outra]]) await p.pessoas.create({ data: { id, igreja_id: tenant, nome_completo: 'Pessoa E04 sintética', data_nascimento: new Date('1980-01-01'), sexo: 'FEMININO' } });
    for (const [key, id, tenant, perfil] of [['admin', admin, igreja, 'ADMINISTRADOR'], ['secretario', secretario, igreja, 'SECRETARIO'], ['gestor', gestor, igreja, 'GESTOR'], ['auditor', auditor, igreja, 'AUDITOR'], ['outra', randomUUID(), outra, 'ADMINISTRADOR']] as const) {
      const u = await p.usuarios.create({ data: { id, igreja_id: tenant, pessoa_id: key === 'gestor' ? pessoa : null, nome_usuario: `E04 ${key}`, email_login: key === 'outra' ? `${admin}@example.invalid` : `${id}@example.invalid`, senha_hash: 'inutilizavel', perfil, ativo: true } });
      cookies[key] = `provisao_session=${await app.get(SessionService).create(id, tenant, u.auth_version)}`;
    }
  });
  afterAll(async () => { if (flag === undefined) delete process.env.FEATURE_SECRETARIA; else process.env.FEATURE_SECRETARIA = flag; if (app) await app.close(); });

  it('fecha funcionalidade por padrão; exige sessão, CSRF e perfil; prepara assembleia própria e competência explícita', async () => {
    delete process.env.FEATURE_SECRETARIA;
    await get('contextos').expect(404);
    process.env.FEATURE_SECRETARIA = 'true';
    await request(app.getHttpServer()).get('/secretaria/contextos').expect(401);
    await request(app.getHttpServer()).post('/secretaria/contextos').set('Cookie', cookies.admin).send({}).expect(403);
    const c = { tipo: 'ASSEMBLEIA_GERAL', nome: 'Assembleia Geral', sigla: 'AG', idempotencia: randomUUID() };
    await post('contextos').send(c).expect(403);
    const resposta = await post('contextos', 'admin').send(c).expect(201); contexto = resposta.body.id;
    expect((await post('contextos', 'admin').send(c).expect(201)).body).toEqual(resposta.body);
    await post('contextos', 'admin').send({ ...c, sigla: 'OUTRA' }).expect(409);
    contextoOutra = (await post('contextos', 'outra').send({ ...c, idempotencia: randomUUID() }).expect(201)).body.id;
    const grant = { contexto_id: contexto, usuario_id: gestor, inicio: '2020-01-01', pode_aprovar: true, pode_deliberar: true, pode_consultar_restritos: true, autoridade: 'Conselho', evidencia: 'Ato externo conferido', idempotencia: randomUUID() };
    await post('competencias', 'gestor').send(grant).expect(403);
    await post('competencias', 'outra').send(grant).expect(404);
    await post('competencias', 'admin').send(grant).expect(201);
    const lista = await get('contextos', 'admin').expect(200);
    expect(lista.headers['cache-control']).toBe('private, no-store');
    expect(lista.body[0]).toMatchObject({ tipo: 'ASSEMBLEIA_GERAL', orgao_id: null, pode_aprovar: false });
    expect(await p.orgao_interno.count({ where: { igreja_id: igreja } })).toBe(0);
  });

  it('valida cargos existentes no contexto; cria e versiona modelos imutáveis', async () => {
    const entrada = { contexto_id: contexto, nome: 'Ata assembleia', tipo: 'ATA', finalidade: 'ATA_AGO', configuracao: config, idempotencia: randomUUID() };
    await post('modelos').send({ ...entrada, configuracao: { ...config, cargos_obrigatorios: [randomUUID()] } }).expect(400);
    await post('modelos', 'auditor').send(entrada).expect(403);
    const m = await post('modelos').send(entrada).expect(201); modeloId = m.body.id; modeloVersao = m.body.versao_id;
    await expect(p.modelo_documento_versao.update({ where: { id: modeloVersao }, data: { finalidade: 'ADULTERADA' } })).rejects.toThrow();
    await get(`modelos?contexto=${contexto}`, 'outra').expect(404);
  });

  it('registra reunião e mesa sem duplicar pessoa; detecta conflito e rejeita presença cruzada', async () => {
    const entrada = { contexto_id: contexto, dados: reuniaoDados(), idempotencia: randomUUID() };
    await post('reunioes').send({ ...entrada, dados: { ...entrada.dados, participantes: [...entrada.dados.participantes, entrada.dados.participantes[0]] } }).expect(400);
    await post('reunioes').send({ ...entrada, dados: { ...entrada.dados, participantes: [{ pessoa_id: pessoaOutra, presente: true, papeis: ['PRESIDENTE'] }] } }).expect(400);
    reuniao = (await post('reunioes').send(entrada).expect(201)).body.id;
    await patch(`reunioes/${reuniao}`).send({ revisao: 9, dados: reuniaoDados(), idempotencia: randomUUID() }).expect(409);
    const r = await get(`reunioes?contexto=${contexto}`).expect(200);
    expect(r.body[0].participantes).toHaveLength(1);
    expect(r.body[0].participantes[0].papeis).toHaveLength(2);
  });

  it('gera rascunho privado idempotente, verifica hash e rejeita acesso de outra igreja', async () => {
    const v = versao();
    v.conteudo.estrutura = { cabecalho: [], corpo: [{ tipo: 'TEXTO', texto: 'Local: {{LOCAL}}', alinhamento: 'CENTRO', estilo: 'NORMAL' }], rodape: [] };
    const id = await criarDoc(v);
    const [primeiro, repetido] = await Promise.all([
      post(`documentos/${id}/rascunhos`).send({ revisao: 1 }).expect(201),
      post(`documentos/${id}/rascunhos`).send({ revisao: 1 }).expect(201),
    ]);
    expect(repetido.body.id).toBe(primeiro.body.id);
    await get(`documentos/${id}/rascunhos/${primeiro.body.id}`, 'outra').expect(404);
    // Simula a perda do processo anterior antes de gravar o resultado.
    await p.trabalho_renderizacao.update({ where: { id: primeiro.body.id }, data: {
      estado: 'PROCESSANDO', reserva_id: randomUUID(), reserva_ate: new Date(0), tentativas: 1,
    } });
    const recuperado = await processarAte(primeiro.body.id);
    expect(recuperado).toMatchObject({ estado: 'CONCLUIDO', tentativas: 2 });
    const estado = await get(`documentos/${id}/rascunhos/${primeiro.body.id}`).expect(200);
    expect(estado.body.estado).toBe('CONCLUIDO');
    const arquivo = await get(`documentos/${id}/rascunhos/${primeiro.body.id}/arquivo`).expect(200);
    expect(createHash('sha256').update(arquivo.body as Buffer).digest('hex')).toBe(estado.body.sha256);
    await request(app.getHttpServer()).get(`/arquivos-privados/${recuperado.arquivo_id}`).set('Cookie', cookies.secretario).expect(404);
  }, 60000);

  it('não associa rascunho gerado após mudança de revisão e bloqueia campo não resolvido', async () => {
    const v = versao();
    v.conteudo.estrutura = { cabecalho: [], corpo: [{ tipo: 'TEXTO', texto: 'Destino: {{DESTINO}}', alinhamento: 'ESQUERDA', estilo: 'NORMAL' }], rodape: [] };
    const id = await criarDoc(v);
    await post(`documentos/${id}/encaminhar`).send(cmd(1)).expect(400);
    const job = await post(`documentos/${id}/rascunhos`).send({ revisao: 1 }).expect(201);
    v.conteudo.campos.DESTINO = 'Assembleia';
    await patch(`documentos/${id}`).send({ revisao: 1, versao: v, idempotencia: randomUUID() }).expect(200);
    expect(await processarAte(job.body.id)).toMatchObject({ estado: 'OBSOLETO', arquivo_id: null });
    const estado = await get(`documentos/${id}/rascunhos/${job.body.id}`).expect(200);
    expect(estado.body).toMatchObject({ estado: 'OBSOLETO', disponivel: false });
    await get(`documentos/${id}/rascunhos/${job.body.id}/arquivo`).expect(404);
  }, 60000);

  it('aplica estrutura e imagem da versão do modelo a outro preparador e valida tipos no servidor', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ZkAAAAASUVORK5CYII=', 'base64');
    const upload = await request(app.getHttpServer()).post('/arquivos-privados').set('Cookie', cookies.gestor)
      .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').attach('file', png, 'imagem.png').expect(201);
    const m = await post('modelos', 'gestor').send({
      contexto_id: contexto, nome: 'Modelo com imagem', tipo: 'OUTRO', finalidade: 'RELATORIO', idempotencia: randomUUID(),
      configuracao: {
        ...config, tipos_campos: { LOCAL: 'DATA' },
        estrutura_padrao: { cabecalho: [{ tipo: 'IMAGEM', arquivo_id: upload.body.id, descricao: 'Imagem institucional de teste' }], corpo: [], rodape: [] },
      },
    }).expect(201);
    const v = versao(m.body.versao_id, null);
    await post('documentos').send({ contexto_id: contexto, restrito: false, versao: v, idempotencia: randomUUID() }).expect(400);
    v.conteudo.campos.LOCAL = '2026-01-10';
    const id = await criarDoc(v);
    const salvo = (await detalhe(id)).versoes[0];
    expect(salvo.conteudo.estrutura.cabecalho[0].arquivo_id).toBe(upload.body.id);
    expect(salvo.anexos[0].arquivo_id).toBe(upload.body.id);
    const imagem = `documentos/${id}/versoes/${salvo.id}/anexos/${upload.body.id}?visualizacao=imagem`;
    const inline = await get(imagem).expect(200).expect('Content-Type', /image\/png/);
    expect(inline.body).toEqual(png);
    await get(imagem, 'outra').expect(404);
    const job = await post(`documentos/${id}/rascunhos`).send({ revisao: 1 }).expect(201);
    expect(await processarAte(job.body.id)).toMatchObject({ estado: 'CONCLUIDO' });
  }, 60000);

  it('mantém as consultas HTTP durante a renderização e impede reserva simultânea', async () => {
    const v = versao();
    v.conteudo.estrutura = {
      cabecalho: [], rodape: [],
      corpo: [{ tipo: 'TABELA', primeira_linha_cabecalho: true, linhas: [
        ['Nº', 'Descrição'],
        ...Array.from({ length: 90 }, (_, i) => [String(i + 1), 'Prestação de contas. '.repeat(25)]),
      ] }],
    };
    const id = await criarDoc(v);
    const job = await post(`documentos/${id}/rascunhos`).send({ revisao: 1 }).expect(201);
    const worker = app.get(RascunhosService);
    const concorrentes = await Promise.all([
      worker.executarUm(), worker.executarUm(),
      Promise.all(Array.from({ length: 36 }, () => get('contextos').expect(200))),
    ]);
    expect(concorrentes.slice(0, 2).sort()).toEqual([false, true]);
    expect(await processarAte(job.body.id)).toMatchObject({ estado: 'CONCLUIDO', tentativas: 1 });
  }, 60000);

  it('preserva o modelo usado na minuta e rejeita referências de outra igreja ou PATCH de estado', async () => {
    const id = await criarDoc();
    const segunda = await post(`modelos/${modeloId}/versoes`).send({ revisao: 1, tipo: 'ATA', finalidade: 'ATA_AGO', configuracao: { ...config, campos_obrigatorios: ['OUTRO_CAMPO'] }, idempotencia: randomUUID() }).expect(201);
    const d = await detalhe(id); expect(d.versoes[0].modelo.id).toBe(modeloVersao); expect(d.versoes[0].modelo.id).not.toBe(segunda.body.versao_id);
    await post(`modelos/${modeloId}/versoes`).send({ revisao: 1, tipo: 'ATA', finalidade: 'ATA_AGO', configuracao: config, idempotencia: randomUUID() }).expect(409);
    await patch(`documentos/${id}`).send({ revisao: 1, estado: 'EXPEDIDO', versao: versao(), idempotencia: randomUUID() }).expect(400);
    await post('documentos').send({ contexto_id: contextoOutra, restrito: false, versao: versao(), idempotencia: randomUUID() }).expect(404);
    const v = versao(); v.conteudo.arrolados[0].pessoa_id = pessoaOutra;
    await post('documentos').send({ contexto_id: contexto, restrito: false, versao: v, idempotencia: randomUUID() }).expect(400);
    await get(`documentos/${id}`, 'outra').expect(404);
    await patch(`documentos/${id}`).send({ revisao: 2, versao: versao(), idempotencia: randomUUID() }).expect(409);
  });

  it('rejeita motivador autorreferente e ciclos também no banco', async () => {
    const a = await criarDoc(), b = await criarDoc();
    const da = await detalhe(a), db = await detalhe(b);
    const va = versao(); va.motivador_id = da.versoes[0].id;
    await patch(`documentos/${a}`).send({ revisao: 1, versao: va, idempotencia: randomUUID() }).expect(400);
    va.motivador_id = db.versoes[0].id;
    await patch(`documentos/${a}`).send({ revisao: 1, versao: va, idempotencia: randomUUID() }).expect(200);
    const vb = versao(); vb.motivador_id = da.versoes[0].id;
    await patch(`documentos/${b}`).send({ revisao: 1, versao: vb, idempotencia: randomUUID() }).expect(400);
    await expect(p.documento_versao.update({ where: { id: db.versoes[0].id }, data: { motivador_id: da.versoes[0].id } })).rejects.toThrow();
  });

  it('aprovação técnica exige deliberação, responsável, assinatura e competência; congela a fonte', async () => {
    const sem = versao(); sem.conteudo.arrolados = [];
    const vazio = await criarDoc(sem);
    await post(`documentos/${vazio}/encaminhar`).send(cmd(1)).expect(400);
    aprovado = await criarDoc();
    await encaminhar(aprovado);
    let d = await detalhe(aprovado);
    await post(`documentos/${aprovado}/aprovar`, 'admin').send(cmd(d.revisao)).expect(403);
    await post(`documentos/${aprovado}/aprovar`, 'gestor').send(cmd(d.revisao)).expect(400);
    await deliberar(aprovado);
    await aprovar(aprovado);
    d = await detalhe(aprovado); aprovadoVersao = d.versoes[0].id;
    const historico = await get(`documentos/${aprovado}/historico`).expect(200); expect(historico.body.map(x => x.operacao)).toEqual(expect.arrayContaining(['CRIAR_DOCUMENTO', 'DELIBERAR_ATA', 'APROVAR']));
    expect(d.estado).toBe('APROVADO'); expect(d.versoes[0].arrolados).toHaveLength(1);
    expect(d.versoes[0].fonte_congelada.arrolados).toHaveLength(1);
    const snapshot = d.versoes[0].fonte_congelada;
    expect(snapshot.aprovacao_tecnica.pessoa_id).toBe(pessoa);
    expect(snapshot.aprovacao_tecnica.competencias_ids).toHaveLength(1);
    const lista = await get(`documentos/${aprovado}/artefatos`).expect(200);
    expect(lista.body).toHaveLength(1);
    const matriz = lista.body[0];
    expect(matriz).toMatchObject({ estado: 'PENDENTE', finalidade: 'MATRIZ_APROVADA', versao_id: aprovadoVersao });
    await get(`documentos/${aprovado}/artefatos`, 'outra').expect(404);
    await p.pessoas.update({ where: { id: pessoa }, data: { nome_completo: 'Nome novo não retroativo' } });
    await p.igreja.update({ where: { id: igreja }, data: { nome: 'Igreja renomeada' } });
    expect((await detalhe(aprovado)).versoes[0].fonte_congelada).toEqual(snapshot);
    const gerado = await processarAte(matriz.id);
    const pdf = await get(`documentos/${aprovado}/artefatos/${matriz.id}/arquivo`).expect(200);
    const texto = execFileSync('pdftotext', ['-', '-'], { input: pdf.body }).toString();
    expect(texto).toContain('E04 Alfa');
    expect(texto).toContain('Pessoa E04 sintética');
    expect(texto).not.toContain('Igreja renomeada');
    expect(texto).not.toContain('RASCUNHO');
    const metadados = await p.arquivo_privado.findUniqueOrThrow({ where: { id: gerado.arquivo_id! } });
    expect(createHash('sha256').update(pdf.body as Buffer).digest('hex')).toBe(metadados.sha256);
    await expect(p.arquivo_privado.update({ where: { id: metadados.id }, data: { sha256: 'outro' } })).rejects.toThrow();
    await expect(p.trabalho_renderizacao.delete({ where: { id: matriz.id } })).rejects.toThrow();
    await patch(`documentos/${aprovado}`).send({ revisao: d.revisao, versao: versao(), idempotencia: randomUUID() }).expect(400);
    await expect(p.documento_versao.update({ where: { id: aprovadoVersao }, data: { assunto: 'Adulteração' } })).rejects.toThrow();
    await expect(p.arrolado_documento.updateMany({ where: { versao_id: aprovadoVersao }, data: { assina: false } })).rejects.toThrow();
    await patch(`reunioes/${reuniao}`).send({ revisao: 1, dados: reuniaoDados(), idempotencia: randomUUID() }).expect(400);
    await post(`documentos/${aprovado}/assinar`).send({}).expect(404);
    await post(`documentos/${aprovado}/expedir`).send({}).expect(404);
    await expect(p.documento.update({ where: { id: aprovado }, data: { estado: 'EXPEDIDO' } })).rejects.toThrow();
  });

  it('retifica sem sobrescrever versão e exige deliberação do novo conteúdo, inclusive reunião posterior', async () => {
    const d = await detalhe(aprovado);
    await post(`documentos/${aprovado}/retificar`, 'gestor').send({ ...cmd(d.revisao), versao: { ...versao(), assunto: 'Ata retificada' } }).expect(201);
    let novo = await detalhe(aprovado);
    expect(novo.versoes).toHaveLength(2); expect(novo.versoes[0].congelado_em).toBeTruthy(); expect(novo.versoes[1].retifica_versao_id).toBe(aprovadoVersao);
    await encaminhar(aprovado);
    novo = await detalhe(aprovado);
    await post(`documentos/${aprovado}/aprovar`, 'gestor').send(cmd(novo.revisao)).expect(400);
    const posterior = (await post('reunioes').send({ contexto_id: contexto, dados: reuniaoDados('2026-02-01'), idempotencia: randomUUID() }).expect(201)).body.id;
    await post(`documentos/${aprovado}/deliberar`, 'gestor').send({ ...cmd(novo.revisao), reuniao_id: posterior, resultado: 'APROVADA', data: '2026-02-01' }).expect(201);
    novo = await detalhe(aprovado);
    await patch(`documentos/${aprovado}`).send({ revisao: novo.revisao, versao: { ...versao(), assunto: 'Texto alterado depois da deliberação' }, idempotencia: randomUUID() }).expect(200);
    await encaminhar(aprovado); novo = await detalhe(aprovado);
    await post(`documentos/${aprovado}/aprovar`, 'gestor').send(cmd(novo.revisao)).expect(400);
    await deliberar(aprovado); await aprovar(aprovado);
    expect((await detalhe(aprovado)).versoes[1].congelado_em).toBeTruthy();
  });

  it('reserva números concorrentes distintos; cancelamento não libera número e série OUTRO é independente', async () => {
    const ids = [await criarDoc(), await criarDoc()];
    await Promise.all(ids.map(id => encaminhar(id)));
    const docs = await Promise.all(ids.map(id => detalhe(id)));
    expect(new Set(docs.map(d => d.numero)).size).toBe(2);
    const cancelado = docs[0];
    await post(`documentos/${cancelado.id}/cancelar`, 'gestor').send(cmd(cancelado.revisao)).expect(201);
    const proximo = await criarDoc(); await encaminhar(proximo);
    expect((await detalhe(proximo)).numero).toBeGreaterThan(Math.max(...docs.map(d => d.numero)));
    const outro = (await post('modelos').send({ contexto_id: contexto, nome: 'Carta', tipo: 'OUTRO', finalidade: 'CARTA', configuracao: { ...config, perfil: 'CARTA', registro_livro: false }, idempotencia: randomUUID() }).expect(201)).body.versao_id;
    const carta = await criarDoc(versao(outro, null)); await encaminhar(carta);
    expect((await detalhe(carta)).numero).toBe(1);
    await p.contador_documento.create({ data: { igreja_id: igreja, contexto_id: contexto, tipo: 'ATA', perfil: 'ATA_PADRAO', ano: 2025, ultimo: 999 } });
    const v = versao(); v.data_documento = '2025-12-01'; v.reuniao_id = (await post('reunioes').send({ contexto_id: contexto, dados: reuniaoDados('2025-12-01'), idempotencia: randomUUID() }).expect(201)).body.id;
    const mil = await criarDoc(v); await encaminhar(mil); expect((await detalhe(mil)).numero).toBe(1000);
  });

  it('detecta duas edições simultâneas e repete encaminhamento sem consumir outro número', async () => {
    const id = await criarDoc();
    const respostas = await Promise.all(['Primeira edição', 'Segunda edição'].map(assunto => patch(`documentos/${id}`).send({ revisao: 1, versao: { ...versao(), assunto }, idempotencia: randomUUID() })));
    expect(respostas.map(r => r.status).sort()).toEqual([200, 409]);
    const d = await detalhe(id), entrada = cmd(d.revisao);
    const envio = await post(`documentos/${id}/encaminhar`).send(entrada).expect(201);
    const reserva = (await detalhe(id)).numero;
    expect((await post(`documentos/${id}/encaminhar`).send(entrada).expect(201)).body).toEqual(envio.body);
    expect((await detalhe(id)).numero).toBe(reserva);
  });

  it('admite Conselho, Junta e unidades com aplicabilidade por constituição e cargos locais', async () => {
    const contextos: string[] = [], cargos: string[] = [];
    for (const tipo of ['CONSELHO', 'JUNTA', 'UNIDADE_MINISTERIAL'] as const) {
      const orgao = await p.orgao_interno.create({ data: { igreja_id: igreja, tipo, constituicao: tipo === 'UNIDADE_MINISTERIAL' ? 'DESIGNACAO' : 'OFICIAL', nome: `Órgão ${tipo}`, sigla: tipo.slice(0, 3), finalidade: 'Reuniões sintéticas', data_criacao: new Date('2020-01-01'), criador_id: admin, instituidor_id: pessoa, evidencia_instituicao: 'Ato sintético' } });
      const cargo = await p.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao.id, codigo: 'RELATOR', nome: 'Relator' } }); cargos.push(cargo.id);
      const c = (await post('contextos', 'admin').send({ tipo: 'ORGAO', orgao_id: orgao.id, nome: orgao.nome, sigla: orgao.sigla, idempotencia: randomUUID() }).expect(201)).body.id; contextos.push(c);
      const conf = { ...config, contexto: 'ORGAO', tipos_orgao: [tipo], constituicoes: [orgao.constituicao], cargos_obrigatorios: [cargo.id] };
      await post('modelos').send({ contexto_id: c, nome: 'Ata órgão', tipo: 'ATA', finalidade: 'ATA_REUNIAO', configuracao: conf, idempotencia: randomUUID() }).expect(201);
      await post('modelos').send({ contexto_id: c, nome: 'Ata incompatível', tipo: 'ATA', finalidade: 'ATA_REUNIAO', configuracao: { ...conf, constituicoes: tipo === 'UNIDADE_MINISTERIAL' ? ['OFICIAL'] : ['DESIGNACAO'] }, idempotencia: randomUUID() }).expect(400);
      await post('reunioes').send({ contexto_id: c, dados: { ...reuniaoDados(), modalidade: 'ORDINARIA' }, idempotencia: randomUUID() }).expect(201);
    }
    await post('modelos').send({ contexto_id: contextos[0], nome: 'Cargo cruzado', tipo: 'ATA', finalidade: 'ATA_REUNIAO', configuracao: { ...config, contexto: 'ORGAO', tipos_orgao: ['CONSELHO'], constituicoes: ['OFICIAL'], cargos_obrigatorios: [cargos[1]] }, idempotencia: randomUUID() }).expect(400);
  });

  it('resolve dois cargos acumulados com uma única pessoa e uma única assinatura obrigatória', async () => {
    await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, data_evento: new Date('2019-01-01'), tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE' } });
    const orgao = await p.orgao_interno.create({ data: { igreja_id: igreja, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'DESIGNACAO', nome: 'Unidade acumulação', sigla: 'UA', finalidade: 'Ensaio', data_criacao: new Date('2020-01-01'), criador_id: admin, instituidor_id: pessoa, evidencia_instituicao: 'Ato sintético' } });
    const cargos: string[] = [];
    for (const codigo of ['RELATOR', 'SECRETARIO_ADJUNTO']) {
      const cargo = await p.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao.id, codigo, nome: codigo, permite_acumulacao: true } }); cargos.push(cargo.id);
      await p.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgao.id, cargo_id: cargo.id, pessoa_id: pessoa, inicio: new Date('2020-01-01') } });
    }
    const c = (await post('contextos', 'admin').send({ tipo: 'ORGAO', orgao_id: orgao.id, nome: orgao.nome, sigla: 'UA', idempotencia: randomUUID() }).expect(201)).body.id;
    await post('competencias', 'admin').send({ contexto_id: c, usuario_id: gestor, inicio: '2020-01-01', pode_aprovar: true, pode_deliberar: false, pode_consultar_restritos: false, autoridade: 'Gestor', evidencia: 'Ato sintético', idempotencia: randomUUID() }).expect(201);
    const m = (await post('modelos').send({ contexto_id: c, nome: 'Relatório', tipo: 'OUTRO', finalidade: 'RELATORIO', configuracao: { ...config, contexto: 'ORGAO', tipos_orgao: ['UNIDADE_MINISTERIAL'], constituicoes: ['DESIGNACAO'], cargos_obrigatorios: cargos }, idempotencia: randomUUID() }).expect(201)).body.versao_id;
    const v = versao(m, null); v.conteudo.arrolados[0].cargos_ids = cargos;
    const id = (await post('documentos').send({ contexto_id: c, restrito: false, versao: v, idempotencia: randomUUID() }).expect(201)).body.id;
    await encaminhar(id); await aprovar(id);
    const d = await detalhe(id);
    expect(d.versoes[0].arrolados).toHaveLength(1);
    expect(d.versoes[0].arrolados[0].retrato.cargos).toHaveLength(2);
    expect(await p.cargo_arrolado_documento.count({ where: { versao_id: d.versoes[0].id } })).toBe(2);
    await expect(p.cargo_arrolado_documento.deleteMany({ where: { versao_id: d.versoes[0].id } })).rejects.toThrow();
  });

  it('isola anexos e acervo restrito também em listas, logs e downloads', async () => {
    const upload = await request(app.getHttpServer()).post('/arquivos-privados').set('Cookie', cookies.gestor).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').attach('file', Buffer.from('anexo sintético'), 'anexo.txt').expect(201);
    const v = versao(); v.conteudo.anexos = [{ arquivo_id: upload.body.id, nome: 'evidencia.txt' }];
    await post('documentos').send({ contexto_id: contexto, restrito: false, versao: v, idempotencia: randomUUID() }).expect(400);
    const entradaRestrita = { contexto_id: contexto, restrito: true, versao: v, idempotencia: randomUUID() };
    const id = (await post('documentos', 'gestor').send(entradaRestrita).expect(201)).body.id;
    const d = (await get(`documentos/${id}`, 'gestor').expect(200)).body;
    for (const user of ['secretario', 'admin', 'auditor', 'outra']) {
      await get(`documentos/${id}`, user).expect(404);
      await get(`documentos/${id}/historico`, user).expect(404);
      const lista = await get(`documentos?contexto=${user === 'outra' ? contextoOutra : contexto}`, user).expect(200); expect(JSON.stringify(lista.body)).not.toContain(id);
      await get(`documentos/${id}/versoes/${d.versoes[0].id}/anexos/${upload.body.id}`, user).expect(404);
    }
    const link = `documentos/${id}/versoes/${d.versoes[0].id}/anexos/${upload.body.id}`;
    const anexo = await get(link, 'gestor').expect(200); expect(anexo.headers['content-type']).toContain('application/octet-stream');
    const logs = await request(app.getHttpServer()).get('/logs').set('Cookie', cookies.auditor).expect(200); expect(JSON.stringify(logs.body)).not.toContain(id);
    await expect(p.anexo_documento.create({ data: { igreja_id: outra, contexto_id: contextoOutra, versao_id: d.versoes[0].id, arquivo_id: upload.body.id, nome: 'cruzado' } })).rejects.toThrow();
    const rascunho = await post(`documentos/${id}/rascunhos`, 'gestor').send({ revisao: 1 }).expect(201);
    expect(await processarAte(rascunho.body.id)).toMatchObject({ estado: 'CONCLUIDO' });
    const linkPdf = `documentos/${id}/artefatos/${rascunho.body.id}/arquivo`;
    await get(linkPdf, 'gestor').expect(200);
    await get(linkPdf, 'auditor').expect(404);
    const outraPessoaLocal = await p.pessoas.create({ data: { igreja_id: igreja, nome_completo: 'Outra identidade', data_nascimento: new Date('1980-01-01'), sexo: 'FEMININO' } });
    await p.usuarios.update({ where: { id: gestor }, data: { pessoa_id: outraPessoaLocal.id } });
    await get(`documentos/${id}`, 'gestor').expect(404);
    await get(linkPdf, 'gestor').expect(404);
    await p.usuarios.update({ where: { id: gestor }, data: { pessoa_id: pessoa } });
    await get(`documentos/${id}`, 'gestor').expect(200);
    const concessao = await p.competencia_secretaria.findFirstOrThrow({ where: { usuario_id: gestor, contexto_id: contexto } });
    await post(`competencias/${concessao.id}/encerrar`, 'admin').send({ fim: '2026-11-01', autoridade: 'Conselho', evidencia: 'Encerramento', idempotencia: randomUUID() }).expect(201);
    await get(`documentos/${id}`, 'gestor').expect(404);
    await post('documentos', 'gestor').send(entradaRestrita).expect(404);
    await post(`documentos/${d.id}/cancelar`, 'gestor').send(cmd(1)).expect(404);
  });
  it('conta somente o acervo visível e limita o perfil à pessoa da sessão', async () => {
    await get(`contextos/${contexto}/resumo`, 'outra').expect(404);
    const resumo = (await get(`contextos/${contexto}/resumo`, 'auditor').expect(200)).body;
    expect(resumo.documentos).toBe(await p.documento.count({ where: { igreja_id: igreja, contexto_id: contexto, restrito: false } }));
    await get(`reunioes/${reuniao}`, 'outra').expect(404);
    const perfil = (user: string) => request(app.getHttpServer()).get('/perfil').set('Cookie', cookies[user]);
    expect((await perfil('gestor').expect(200)).body.pessoa.id).toBe(pessoa);
    expect((await perfil('outra').query({ pessoa_id: pessoa }).expect(200)).body.pessoa).toBeNull();
    await request(app.getHttpServer()).get('/perfil').expect(401);
  });

  it('altera a senha pela própria sessão e exige novo login', async () => {
    const bcrypt = await import('bcrypt');
    const login = admin + '@example.invalid';
    const atual = 'senha-atual-de-teste';
    const nova = 'senha-nova-de-teste';
    await p.usuarios.update({ where: { id: admin }, data: { senha_hash: await bcrypt.hash(atual, 4) } });
    const alterar = (senha_atual: string) => request(app.getHttpServer()).post('/auth/alterar-senha')
      .set('Cookie', cookies.admin).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1')
      .send({ senha_atual, nova_senha: nova });
    await alterar('incorreta').expect(400);
    await alterar(atual).expect(204);
    await request(app.getHttpServer()).get('/auth/profile').set('Cookie', cookies.admin).expect(401);
    await request(app.getHttpServer()).post('/auth/login').set('Origin', 'http://localhost:3001')
      .set('X-Provisao-Request', '1').send({ igreja_id: igreja, login, senha: nova }).expect(200);
  });

});
