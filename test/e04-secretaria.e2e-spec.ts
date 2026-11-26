import { habilitarAutorDeTeste } from './fixtures/autor-modelo';
import { createHash, randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
import { ConfiguracaoModelo, VersaoInput } from '../src/secretaria/secretaria.dto';
import { RascunhosService } from '../src/secretaria/rascunhos.service';
import { unlink } from 'node:fs/promises';
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
    const assembleia = lista.body.find(c => c.id === contexto);
    expect(assembleia).toMatchObject({ tipo: 'ASSEMBLEIA_GERAL', pode_aprovar: false });
    expect(await p.orgao_interno.findUniqueOrThrow({ where: { id: assembleia.orgao_id } })).toMatchObject({ igreja_id: igreja, tipo_padrao: 'ASSEMBLEIA_GERAL' });
  });

  it('valida cargos existentes no contexto; cria e versiona modelos imutáveis', async () => {
    config.atuacao = { criar: [await habilitarAutorDeTeste(p, igreja, secretario), await habilitarAutorDeTeste(p, igreja, gestor)], preparar: [], assinar: [] };
    const entrada = { contexto_id: contexto, nome: 'Ata assembleia', tipo: 'ATA', finalidade: 'ATA_AGO', configuracao: config, idempotencia: randomUUID() };
    await post('modelos').send({ publicar: true, ...entrada, configuracao: { ...config, cargos_obrigatorios: [randomUUID()] } }).expect(400);
    await post('modelos', 'auditor').send({ ...entrada, publicar: true }).expect(403);
    const m = await post('modelos').send({ ...entrada, publicar: true }).expect(201); modeloId = m.body.id; modeloVersao = m.body.versao_id;
    await expect(p.modelo_documento_versao.update({ where: { id: modeloVersao }, data: { finalidade: 'ADULTERADA' } })).rejects.toThrow();
    await get(`modelos?contexto=${contexto}`, 'outra').expect(404);
  });

  it('isola a biblioteca, publica as definições e conserva o significado de cada versão', async () => {
    const campo = { nome: 'Pauta do edital', tipo: 'texto', origem: 'manual', multiplo: true, idempotencia: randomUUID() };
    await post('campos','gestor').send(campo).expect(403);
    const { body: criado } = await post('campos').send(campo).expect(201);
    expect((await post('campos').send(campo).expect(201)).body.id).toBe(criado.id);
    const bibliotecaExterna = (await get('campos','outra').expect(200)).body;
    expect(bibliotecaExterna.map(c => c.id)).not.toContain(criado.id);
    const disponiveis = (await get('campos').expect(200)).body;
    const assunto = disponiveis.find(c => c.codigo === 'ASSUNTO');
    const dataDocumento = disponiveis.find(c => c.codigo === 'DATA_DOCUMENTO');
    const edicao = { ...campo, nome: 'Assuntos convocados', ativo: true, revisao: 1, idempotencia: randomUUID() };
    await patch('campos/'+criado.id,'outra').send(edicao).expect(404);
    const espaco = { superior: 0, inferior: 0 };
    const composicao = { versao_formato: 1, pagina: { papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
      margens_cm: { superior: 2, inferior: 2, direita: 2, esquerda: 2 }, espacamento_cm: { corpo: espaco, cabecalho: espaco, rodape: espaco } },
      cabecalho: [{ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'campo', campo_id: assunto.id, apresentacao: 'individual' }] }],
      rodape: [], notas: {}, corpo: [{ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'campo', campo_id: criado.id, apresentacao: 'lista_numerada' }] }] };
    const modelo = { tipo: 'OUTRO', finalidade: 'EDITAL', configuracao: { ...config, composicao_padrao: composicao, obrigatorios_biblioteca: [criado.id, dataDocumento.id] } };
    const criar = { ...modelo, contexto_id: contexto, nome: 'Edital com pauta', idempotencia: randomUUID() };
    await post('modelos','outra').send({ publicar: true, ...criar, contexto_id: contextoOutra }).expect(400);
    const { body: m } = await post('modelos').send({ ...criar, publicar: true }).expect(201);
    await patch('campos/'+criado.id).send(edicao).expect(200);
    await patch('campos/'+criado.id).send({ ...edicao, idempotencia: randomUUID() }).expect(409);
    await post('modelos/'+m.id+'/versoes').send({ ...modelo, revisao: 1, idempotencia: randomUUID() }).expect(201);
    const versoes = (await get('modelos?contexto='+contexto)).body.find(x => x.id === m.id).versoes;
    expect(versoes.map(x => x.configuracao.definicoes[criado.id].nome)).toEqual([edicao.nome, campo.nome]);
    await patch('campos/'+criado.id).send({ ...edicao, revisao: 2, ativo: false, idempotencia: randomUUID() }).expect(200);
    await post('modelos/'+m.id+'/versoes').send({ ...modelo, revisao: 2, idempotencia: randomUUID() }).expect(400);
    const v = versao(versoes[0].id,null);
    v.conteudo.teor = '';
    const id = await criarDoc(v);
    await post('documentos/'+id+'/encaminhar').send(cmd(1)).expect(400);
    v.conteudo.composicao = (await detalhe(id)).versoes[0].conteudo.composicao;
    v.conteudo.valores = { [criado.id]: { tipo: 'texto', multiplo: true, origem: { tipo: 'manual' }, ajustado_manualmente: true, valor: ['A','B','C'] } };
    const cruzada = structuredClone(v);
    cruzada.conteudo.valores![bibliotecaExterna[0].id] = v.conteudo.valores[criado.id];
    await patch('documentos/'+id).send({ versao: cruzada, revisao: 1, idempotencia: randomUUID() }).expect(400);
    v.conteudo.valores[assunto.id] = { tipo: 'texto', multiplo: false, valor: 'Outro assunto', origem: { tipo: 'manual' }, ajustado_manualmente: true };
    const editar = { versao: v, revisao: 1, idempotencia: randomUUID() };
    const salvo = await patch('documentos/'+id).send(editar).expect(200);
    expect((await patch('documentos/'+id).send(editar).expect(200)).body).toEqual(salvo.body);
    const valores = (await detalhe(id)).versoes[0].conteudo.valores;
    expect(valores[dataDocumento.id]).toMatchObject({ tipo: 'data', valor: dia });
    expect(valores[criado.id]).toEqual(v.conteudo.valores[criado.id]);
    expect(valores[assunto.id]).toMatchObject({ valor: v.assunto, origem: { tipo: 'sistema', chave: 'assunto' }, ajustado_manualmente: false });
    const job = (await post('documentos/'+id+'/rascunhos').send({ revisao: 2 }).expect(201)).body;
    expect(await processarAte(job.id)).toMatchObject({ estado: 'CONCLUIDO' });
    const pdf = await get('documentos/'+id+'/rascunhos/'+job.id+'/arquivo').expect(200);
    const texto = execFileSync('pdftotext', ['-layout','-','-'], { input: pdf.body, encoding: 'utf8' });
    expect(texto).toMatch(/1\.\s+A[\s\S]*2\.\s+B[\s\S]*3\.\s+C/);
  }, 60000);

  it('ordena o contexto pela data da versão atual antes de paginar e desempata por id', async () => {
    const escopo = { igreja_id: outra, contexto_id: contextoOutra };
    const modelo = await post('modelos', 'outra').send({ publicar: true, contexto_id: contextoOutra, nome: 'Atas para consulta',
      tipo: 'ATA', finalidade: 'ATA_AGO', configuracao: { ...config, atuacao: { criar: ['PRESIDENCIA_CONSELHO'], preparar: [], assinar: [] } }, idempotencia: randomUUID() }).expect(201);
    const documentos = Array.from({ length: 31 }, (_, i) => ({
      ...escopo, id: randomUUID(), perfil: 'ATA_PADRAO', tipo: 'ATA' as const,
      criado_em: new Date(Date.UTC(2025, 0, 31 - i)), versao_atual: i === 0 ? 2 : 1,
    }));
    const atuais = documentos.map((d, i) => ({
      ...escopo, documento_id: d.id, modelo_versao_id: modelo.body.versao_id, numero: d.versao_atual,
      assunto: 'Ata para consulta', conteudo: {}, data_documento: new Date(Date.UTC(2020, 0, Math.max(1, i))),
    }));
    await p.$transaction([
      p.documento.createMany({ data: documentos }),
      p.documento_versao.createMany({ data: [...atuais, { ...atuais[0], numero: 1, data_documento: new Date('2030-01-01') }] }),
    ]);

    const caminho = `documentos?contexto=${contextoOutra}&pagina=`;
    const primeira = (await get(caminho + '0', 'outra').expect(200)).body;
    const segunda = (await get(caminho + '1', 'outra').expect(200)).body;
    expect(primeira).toHaveLength(30);
    expect(segunda).toHaveLength(1);
    const esperadas = atuais.sort((a, b) => b.data_documento.getTime() - a.data_documento.getTime()
      || a.documento_id.localeCompare(b.documento_id));
    expect([...primeira, ...segunda].map(d => [d.id, d.versoes[0].data_documento]))
      .toEqual(esperadas.map(v => [v.documento_id, v.data_documento.toISOString()]));
    const consultar = (pagina: number) => get('documentos/consulta','outra').query({
      contexto: contextoOutra, visao: 'andamento', modelo: modelo.body.id, estado: 'EM_EDICAO', busca: 'PARA CONSULTA', de: '2020-01-01', ate: '2020-01-31', pagina,
    }).expect(200);
    const lote = (await consultar(0)).body, fim = (await consultar(1)).body;
    expect(lote.tem_proxima).toBe(true);
    expect(fim.tem_proxima).toBe(false);
    expect([...lote.itens,...fim.itens].map(d => d.id)).toEqual(esperadas.map(v => v.documento_id));
    const listarMotivadores = (pagina: number, ator = 'outra') => get('motivadores', ator)
      .query({ contexto: contextoOutra, assunto: 'para consulta', pagina }).expect(200);
    const a = (await listarMotivadores(0)).body, b = (await listarMotivadores(1)).body;
    expect(a.tem_proxima).toBe(true);
    expect(b.tem_proxima).toBe(false);
    expect([...a.itens, ...b.itens].map(item => item.documento_id)).toEqual(esperadas.map(v => v.documento_id));
    expect((await listarMotivadores(0, 'gestor')).body.itens).toEqual([]);
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

  it('agenda sem mesa e preserva os itens ao reordenar e registrar a abertura', async () => {
    await post('modelos').send({ publicar: true, contexto_id: contexto, nome: 'Edital para agendamento', tipo: 'OUTRO', finalidade: 'CONVOCACAO', configuracao: config, idempotencia: randomUUID() }).expect(201);
    const local = await p.local_reuniao.create({ data: { igreja_id: igreja, descritivo: 'Salão de reunião' } });
    const itens = ['Contas', 'Projeto', 'Informes'].map((descricao, i) => ({ descricao, proponente_id: i === 1 ? pessoa : null }));
    const dados = { restrito: false, situacao: 'AGENDADA', data: '2027-05-10', modalidade: 'AGO', horario_previsto: '19:00', itens_pauta: itens };
    const payload = { contexto_id: contexto, local_id: local.id, dados, idempotencia: randomUUID() };
    const criado = (await post('reunioes').send(payload).expect(201)).body;
    expect((await post('reunioes').send(payload).expect(201)).body.id).toBe(criado.id);
    const ficha = async () => (await get('reunioes/' + criado.id).expect(200)).body;
    const agendada = await ficha();
    expect(agendada.participantes).toHaveLength(0);
    type Item = { id: string; descricao: string; proponente_id: string | null };
    const ordem = [1, 2, 0].map(i => {
      const { id, descricao, proponente_id } = agendada.itens_pauta[i] as Item;
      return { id, descricao, proponente_id };
    });
    const edicao = { ...agendada.dados, itens_pauta: ordem, situacao: 'EM_ANDAMENTO', inicio: '2027-05-10T19:20:00-03:00' };
    const alterar = (d: typeof edicao) => patch('reunioes/' + criado.id).send({ revisao: 1, local_id: local.id, local_efetivo_id: local.id, idempotencia: randomUUID(), dados: d });
    await alterar({ ...edicao, itens_pauta: [ordem[0], ordem[0]] }).expect(400);
    await alterar(edicao).expect(200);
    const realizada = await ficha();
    expect(realizada.dados).toMatchObject({ inicio: edicao.inicio, horario_previsto: '19:00' });
    expect(realizada.local_efetivo_retrato.descritivo).toBe(local.descritivo);
    expect(realizada.itens_pauta).toMatchObject(ordem.map((item, i) => ({ ...item, ordem: i + 1 })));
    await alterar(edicao).expect(409);
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
      publicar: true,
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
    await post('modelos/'+m.body.id+'/editar').send({ revisao: 1, idempotencia: randomUUID() }).expect(201);
    const urlRascunho = 'modelos/'+m.body.id+'/rascunho';
    const dadosModelo = { tipo: 'OUTRO', finalidade: 'RELATORIO', configuracao: {
      ...config, estrutura_padrao: salvo.conteudo.estrutura,
    } };
    await get(urlRascunho+'/imagens/'+upload.body.id).expect(200);
    await get(urlRascunho+'/imagens/'+upload.body.id, 'outra').expect(404);
    await patch(urlRascunho).send({ ...dadosModelo, revisao: 2, idempotencia: randomUUID() }).expect(200);
    const republicado = (await post('modelos/'+m.body.id+'/publicar').send({ ...dadosModelo, revisao: 3, idempotencia: randomUUID() }).expect(201)).body;
    await get(urlRascunho+'/imagens/'+upload.body.id).expect(404);
    for (const versao of [m.body.versao_id, republicado.versao_id]) await get('modelos/versoes/'+versao+'/imagens/'+upload.body.id).expect(200);
    const job = await post(`documentos/${id}/rascunhos`).send({ revisao: 1 }).expect(201);
    expect(await processarAte(job.body.id)).toMatchObject({ estado: 'CONCLUIDO' });
  }, 60000);

  it('congela o logo inserido no rascunho e conserva a ocorrência na versão, no documento e no PDF', async () => {
    const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAYCAIAAAAH5iiXAAAAKElEQVR4nO3NMREAAAgEIDX5RzeF5wIF6FTqw7ysYrFYLBaLxWLxiQVyTAEwT49s/QAAAABJRU5ErkJggg==', 'base64');
    const novo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAYCAIAAAAH5iiXAAAAJ0lEQVR4nO3NMREAAAgEIDW50U3h/QIF6NqKmEwrFovFYrFYLBZ/OMbyALD+dpOIAAAAAElFTkSuQmCC', 'base64');
    const temporarios: string[] = [];
    async function atualizarLogo(bytes: Buffer) {
      const r = await request(app.getHttpServer()).patch('/igrejas/me/logo').set('Cookie', cookies.gestor)
        .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').attach('file', bytes, 'logo.png').expect(200);
      const url: string = r.body.url_logo;
      expect(url).toMatch(/^\/uploads\/church-logos\/[a-f0-9-]+\.png$/);
      temporarios.push('.' + url);
      return (await get('logo-da-igreja').expect(200)).body;
    }
    try {
      const bytes = await atualizarLogo(original);
      const chave = randomUUID();
      const uploadImagem = (data: Buffer) => request(app.getHttpServer()).post('/secretaria/imagens').set('Cookie', cookies.gestor)
        .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').field('idempotencia', chave).attach('file', data, 'logo.png');
      await uploadImagem(Buffer.from('arquivo inválido')).expect(400);
      const upload = await uploadImagem(bytes).expect(201);
      expect((await uploadImagem(bytes).expect(201)).body.id).toBe(upload.body.id);
      await uploadImagem(novo).expect(409);
      const imagem = { tipo: 'imagem', arquivo_id: upload.body.id, ocorrencia_id: randomUUID(), descricao: 'Brasão', legenda: 'Secretaria local',
        largura_cm: 3.7, altura_cm: 1.5, manter_proporcao: true, ajuste: 'ajustar', horizontal: 'esquerda', vertical: 'topo',
        x_cm: 0, y_cm: 0, relacao: 'em_linha', opacidade: 1, distancia_texto_cm: 0 };
      const espaco = { superior: 0, inferior: 0 };
      const pagina = { versao_formato: 2, pagina: { papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
        margens_cm: { superior: 2, inferior: 2, direita: 2, esquerda: 2 }, espacamento_cm: { cabecalho: espaco, corpo: espaco, rodape: espaco },
        altura_minima_cm: { cabecalho: 2.3, rodape: 0 } }, cabecalho: [{ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [imagem] }],
        corpo: [{ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'texto', texto: 'Ofício de teste' }] }], rodape: [], notas: {} };
      const dados = { nome: 'Ofício com brasão', tipo: 'OUTRO', finalidade: 'OFICIO', configuracao: { ...config, composicao_padrao: pagina } };
      const modelo = (await post('modelos','gestor').send({ ...dados, contexto_id: contexto, idempotencia: randomUUID() }).expect(201)).body;
      await get('modelos/'+modelo.id+'/rascunho/imagens/'+imagem.arquivo_id).expect(200);
      const publicada = (await post('modelos/'+modelo.id+'/publicar').send({ ...dados, revisao: 1, idempotencia: randomUUID() }).expect(201)).body;
      const entrada = versao(publicada.versao_id, null);
      entrada.conteudo.teor = '';
      const doc = await criarDoc(entrada);
      expect(await atualizarLogo(novo)).toEqual(novo);
      await get('logo-da-igreja','outra').expect(404);
      const v = (await detalhe(doc)).versoes[0];
      expect(v.conteudo.composicao.cabecalho[0].trechos).toEqual([imagem]);
      const url = 'documentos/'+doc+'/versoes/'+v.id+'/anexos/'+imagem.arquivo_id+'?visualizacao=imagem';
      expect((await get(url).expect(200)).body).toEqual(original);
      expect((await get('modelos/versoes/'+publicada.versao_id+'/imagens/'+imagem.arquivo_id).expect(200)).body).toEqual(original);
      await get(url, 'outra').expect(404);
      const job = (await post('documentos/'+doc+'/rascunhos').send({ revisao: 1 }).expect(201)).body;
      expect(await processarAte(job.id)).toMatchObject({ estado: 'CONCLUIDO' });
      const pdf = (await get('documentos/'+doc+'/rascunhos/'+job.id+'/arquivo').expect(200)).body;
      expect(execFileSync('pdftotext', ['-', '-'], { input: pdf }).toString()).toContain('Secretaria local');
      expect(execFileSync('pdfimages', ['-list', '-'], { input: pdf }).toString()).toMatch(/image\s+40\s+24/);
    } finally {
      await p.igreja.update({ where: { id: igreja }, data: { url_logo: null } });
      await Promise.all(temporarios.map(caminho => unlink(caminho)));
    }
  }, 60000);

  it('converte em nova versão e mantém as duas minutas editáveis durante a pausa', async () => {
    const imagem = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ZkAAAAASUVORK5CYII=', 'base64');
    const arquivo = (await request(app.getHttpServer()).post('/arquivos-privados').set('Cookie', cookies.gestor)
      .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').attach('file', imagem, 'brasao.png').expect(201)).body.id;
    const legado = { tipo: 'OUTRO', finalidade: 'OFICIO', configuracao: { ...config, estrutura_padrao: {
      cabecalho: [{ tipo: 'IMAGEM', arquivo_id: arquivo, descricao: 'Brasão' }],
      corpo: [{ tipo: 'LISTA', ordenada: true, itens: ['Local {{LOCAL}}'] }], rodape: [{ tipo: 'ASSINATURAS' }],
    } } };
    const modelo = (await post('modelos', 'gestor').send({ publicar: true, ...legado, nome: 'Modelo do acervo', contexto_id: contexto, idempotencia: randomUUID() }).expect(201)).body;
    const criar = (modelo_versao_id: string) => {
      const entrada = versao(modelo_versao_id, null);
      entrada.conteudo.teor = '';
      return { versao: entrada, contexto_id: contexto, restrito: false, idempotencia: randomUUID() };
    };
    const antiga = (await post('documentos').send(criar(modelo.versao_id)).expect(201)).body;
    const espaco = { superior: 0, inferior: 0 };
    const linha = { tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'texto', texto: 'Local {{LOCAL}}' }] };
    const pagina = { versao_formato: 1, pagina: { papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
      margens_cm: { superior: 2, inferior: 2, direita: 2, esquerda: 2 }, espacamento_cm: { cabecalho: espaco, corpo: espaco, rodape: espaco } },
      cabecalho: [{ tipo: 'imagem', arquivo_id: arquivo, descricao: 'Brasão' }],
      corpo: [{ tipo: 'lista', ordenada: true, itens: [[linha]] }, { tipo: 'quebra' }, { tipo: 'tabela', linhas: [[[linha]]], primeira_linha_cabecalho: true }],
      rodape: [{ tipo: 'assinaturas' }], notas: {} };
    const inserir = () => post('modelos/'+modelo.id+'/versoes').send({ ...legado, configuracao: { ...config, composicao_padrao: pagina }, revisao: 1, idempotencia: randomUUID() });
    const antes = process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS;
    try {
      process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS = contextoOutra;
      await inserir().expect(409);
      process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS = contexto;
      const nova = (await inserir().expect(201)).body;
      const configuracaoPagina = { ...config, composicao_padrao: { ...pagina, versao_formato: 2,
        pagina: { ...pagina.pagina, altura_minima_cm: { cabecalho: 1, rodape: 1 } } } };
      const dadosModelo = { tipo: 'OUTRO', finalidade: 'OFICIO', configuracao: configuracaoPagina, nome: 'Rascunho da homologação' };
      const rascunho = (await post('modelos', 'gestor').send({ ...dadosModelo, contexto_id: contexto, idempotencia: randomUUID() }).expect(201)).body;
      const versoes = (await get('modelos?contexto='+contexto).expect(200)).body.find(m => m.id === modelo.id).versoes;
      expect(versoes[1]).toMatchObject({ id: modelo.versao_id, configuracao: legado.configuracao });
      const url = 'modelos/versoes/'+nova.versao_id+'/imagens/'+arquivo;
      expect((await get(url).expect(200)).body).toEqual(imagem);
      await get(url, 'outra').expect(404);
      await get('modelos/versoes/'+randomUUID()+'/imagens/'+arquivo).expect(404);
      const comando = criar(nova.versao_id);
      const minuta = (await post('documentos').send(comando).expect(201)).body;
      process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS = '';
      const v2 = (await post('modelos/'+rascunho.id+'/publicar','gestor').send({ ...dadosModelo, revisao: 1, idempotencia: randomUUID() }).expect(201)).body;
      await post('documentos').send(criar(v2.versao_id)).expect(409);
      const conversao = criar(modelo.versao_id).versao;
      await patch('documentos/'+antiga.id).send({ versao: { ...conversao, conteudo: { ...conversao.conteudo, composicao: configuracaoPagina.composicao_padrao } },
        revisao: 1, idempotencia: randomUUID() }).expect(409);
      expect((await post('documentos').send(comando).expect(201)).body).toEqual(minuta);
      await post('documentos').send(criar(nova.versao_id)).expect(409);
      await post('documentos').send(criar(modelo.versao_id)).expect(409);
      for (const id of [antiga.id, minuta.id]) {
        const atual = (await detalhe(id)).versoes[0];
        const entrada = criar(atual.modelo_versao_id).versao;
        entrada.conteudo = atual.conteudo;
        await patch('documentos/'+id).send({ versao: entrada, revisao: 1, idempotencia: randomUUID() }).expect(200);
      }
      const job = (await post('documentos/'+minuta.id+'/rascunhos').send({ revisao: 2 }).expect(201)).body;
      expect(await processarAte(job.id)).toMatchObject({ estado: 'CONCLUIDO' });
      const pdf = (await get('documentos/'+minuta.id+'/rascunhos/'+job.id+'/arquivo').expect(200)).body;
      const texto = execFileSync('pdftotext', ['-layout', '-', '-'], { input: pdf, encoding: 'utf8' });
      expect(texto.match(/Local Templo/g)).toHaveLength(2);
      expect(texto.trim().split('\f')).toHaveLength(2);
    } finally {
      if (antes === undefined) delete process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS;
      else process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS = antes;
    }
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
    const segunda = await post(`modelos/${modeloId}/versoes`).send({ revisao: 1, tipo: 'ATA', finalidade: 'ATA_AGO', configuracao: { ...config, tipos_campos: { OUTRO_CAMPO: 'DATA' } }, idempotencia: randomUUID() }).expect(201);
    const d = await detalhe(id); expect(d.versoes[0].modelo.id).toBe(modeloVersao); expect(d.versoes[0].modelo.id).not.toBe(segunda.body.versao_id);
    await post(`modelos/${modeloId}/versoes`).send({ revisao: 1, tipo: 'ATA', finalidade: 'ATA_AGO', configuracao: config, idempotencia: randomUUID() }).expect(409);
    await patch(`documentos/${id}`).send({ revisao: 1, estado: 'EXPEDIDO', versao: versao(), idempotencia: randomUUID() }).expect(400);
    await post('documentos').send({ contexto_id: contextoOutra, restrito: false, versao: versao(), idempotencia: randomUUID() }).expect(404);
    modeloVersao = segunda.body.versao_id;
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
    const revisaoVazia = await detalhe(vazio);
    expect(revisaoVazia.tramitacao.pendencias).toEqual(expect.arrayContaining([
      { destino: 'arrolados', mensagem: 'Indique o responsável pelo documento.' },
      { destino: 'arrolados', mensagem: 'Indique ao menos um signatário obrigatório.' },
    ]));
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
    const outro = (await post('modelos').send({ publicar: true, contexto_id: contexto, nome: 'Carta', tipo: 'OUTRO', finalidade: 'CARTA', configuracao: { ...config, perfil: 'CARTA', registro_livro: false }, idempotencia: randomUUID() }).expect(201)).body.versao_id;
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
      const orgao = (tipo === 'CONSELHO' && await p.orgao_interno.findFirst({ where: { igreja_id: igreja, tipo } })) || await p.orgao_interno.create({ data: { igreja_id: igreja, tipo, constituicao: tipo === 'UNIDADE_MINISTERIAL' ? 'DESIGNACAO' : 'OFICIAL', nome: `Órgão ${tipo}`, sigla: tipo.slice(0, 3), finalidade: 'Reuniões sintéticas', data_criacao: new Date('2020-01-01'), criador_id: admin, instituidor_id: pessoa, evidencia_instituicao: 'Ato sintético' } });
      const cargo = await p.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao.id, codigo: 'RELATOR', nome: 'Relator' } }); cargos.push(cargo.id);
      const c = (await post('contextos', 'admin').send({ tipo: 'ORGAO', orgao_id: orgao.id, nome: orgao.nome, sigla: orgao.sigla, idempotencia: randomUUID() }).expect(201)).body.id; contextos.push(c);
      const conf = { ...config, atuacao: { criar: [cargo.id], preparar: [], assinar: [] }, contexto: 'ORGAO', tipos_orgao: [tipo], constituicoes: [orgao.constituicao], cargos_obrigatorios: [cargo.id] };
      await post('modelos').send({ publicar: true, contexto_id: c, nome: 'Ata órgão', tipo: 'ATA', finalidade: 'ATA_REUNIAO', configuracao: conf, idempotencia: randomUUID() }).expect(201);
      await post('modelos').send({ publicar: true, contexto_id: c, nome: 'Ata incompatível', tipo: 'ATA', finalidade: 'ATA_REUNIAO', configuracao: { ...conf, constituicoes: tipo === 'UNIDADE_MINISTERIAL' ? ['OFICIAL'] : ['DESIGNACAO'] }, idempotencia: randomUUID() }).expect(400);
      await post('reunioes').send({ contexto_id: c, dados: { ...reuniaoDados(), modalidade: 'ORDINARIA' }, idempotencia: randomUUID() }).expect(201);
    }
    await post('modelos').send({ publicar: true, contexto_id: contextos[0], nome: 'Cargo cruzado', tipo: 'ATA', finalidade: 'ATA_REUNIAO', configuracao: { ...config, contexto: 'ORGAO', tipos_orgao: ['CONSELHO'], constituicoes: ['OFICIAL'], cargos_obrigatorios: [cargos[1]] }, idempotencia: randomUUID() }).expect(400);
  });

  it('resolve dois cargos acumulados com uma única pessoa e uma única assinatura obrigatória', async () => {
    const orgao = await p.orgao_interno.create({ data: { igreja_id: igreja, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'DESIGNACAO', nome: 'Unidade acumulação', sigla: 'UA', finalidade: 'Ensaio', data_criacao: new Date('2020-01-01'), criador_id: admin, instituidor_id: pessoa, evidencia_instituicao: 'Ato sintético' } });
    const cargos: string[] = [];
    for (const codigo of ['RELATOR', 'SECRETARIO_ADJUNTO']) {
      const cargo = await p.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao.id, codigo, nome: codigo, permite_acumulacao: true } }); cargos.push(cargo.id);
      await p.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgao.id, cargo_id: cargo.id, pessoa_id: pessoa, inicio: new Date('2020-01-01') } });
    }
    const c = (await post('contextos', 'admin').send({ tipo: 'ORGAO', orgao_id: orgao.id, nome: orgao.nome, sigla: 'UA', idempotencia: randomUUID() }).expect(201)).body.id;
    await post('competencias', 'admin').send({ contexto_id: c, usuario_id: gestor, inicio: '2020-01-01', pode_aprovar: true, pode_deliberar: false, pode_consultar_restritos: false, autoridade: 'Gestor', evidencia: 'Ato sintético', idempotencia: randomUUID() }).expect(201);
    const m = (await post('modelos').send({ publicar: true, contexto_id: c, nome: 'Relatório', tipo: 'OUTRO', finalidade: 'RELATORIO', configuracao: { ...config, contexto: 'ORGAO', tipos_orgao: ['UNIDADE_MINISTERIAL'], constituicoes: ['DESIGNACAO'], atuacao: { criar: cargos, preparar: [], assinar: [] }, cargos_obrigatorios: cargos }, idempotencia: randomUUID() }).expect(201)).body.versao_id;
    const v = versao(m, null); v.conteudo.arrolados[0].cargos_ids = cargos;
    const id = (await post('documentos', 'gestor').send({ contexto_id: c, restrito: false, versao: v, idempotencia: randomUUID() }).expect(201)).body.id;
    await post('documentos/'+id+'/encaminhar', 'gestor').send(cmd(1)).expect(201); await aprovar(id);
    const d = await detalhe(id);
    expect(d.versoes[0].arrolados).toHaveLength(1);
    expect(d.versoes[0].arrolados[0].retrato.cargos).toHaveLength(2);
    expect(await p.cargo_arrolado_documento.count({ where: { versao_id: d.versoes[0].id } })).toBe(2);
    await expect(p.cargo_arrolado_documento.deleteMany({ where: { versao_id: d.versoes[0].id } })).rejects.toThrow();
  });

  it('encadeia edital e ata, confirma a troca de valores ajustados e conserva a versão da origem', async () => {
    const biblioteca = (await get('campos').expect(200)).body;
    const data = biblioteca.find(c => c.codigo === 'DATA_REUNIAO').id as string;
    const pauta = biblioteca.find(c => c.codigo === 'PAUTA').id as string;
    const espaco = { superior: 0, inferior: 0 };
    const configuracao: ConfiguracaoModelo = { ...config, registro_livro: false, composicao_padrao: {
      versao_formato: 1, pagina: { papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
        margens_cm: { superior: 2, inferior: 2, direita: 2, esquerda: 2 }, espacamento_cm: { corpo: espaco, cabecalho: espaco, rodape: espaco } },
      cabecalho: [], rodape: [], notas: {}, corpo: [{ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [
        { tipo: 'campo', campo_id: data, apresentacao: 'individual' }, { tipo: 'campo', campo_id: pauta, apresentacao: 'lista_numerada' },
      ] }],
    } };
    const edital = { contexto_id: contexto, nome: 'Edital de convocação E4', tipo: 'OUTRO', finalidade: 'CONVOCACAO', configuracao };
    const m = (await post('modelos').send({ publicar: true, ...edital, idempotencia: randomUUID() }).expect(201)).body;
    const atividades = biblioteca.find(c => c.codigo === 'ATIVIDADES').id as string;
    const configAlternativa = structuredClone(configuracao);
    const corpo = configAlternativa.composicao_padrao!.corpo[0];
    if (corpo.tipo === 'paragrafo' && corpo.trechos[1].tipo === 'campo') corpo.trechos[1].campo_id = atividades;
    const alternativo = (await post('modelos').send({ publicar: true, ...edital, nome: 'Edital complementar E4', configuracao: configAlternativa, idempotencia: randomUUID() }).expect(201)).body;
    const campos = { [pauta]: pauta, [data]: data };
    const { body: campoLocal } = await post('campos').send({ nome: biblioteca.find(c => c.id === pauta).nome,
      tipo: 'texto', origem: 'manual', multiplo: true, idempotencia: randomUUID() }).expect(201);
    const composicaoAta = structuredClone(configuracao.composicao_padrao!);
    composicaoAta.corpo.push({ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'campo', campo_id: campoLocal.id, apresentacao: 'em_linha' }] });
    const ata = { ...edital, nome: 'Ata encadeada E4', tipo: 'ATA', finalidade: 'ATA_AGO',
      configuracao: { ...configuracao, composicao_padrao: composicaoAta, motivador: 'OBRIGATORIO', antecedentes: [{ modelo_id: m.id, campos }, { modelo_id: alternativo.id, campos: { [data]: data, [pauta]: atividades } }] } };
    const destino = (await post('modelos').send({ publicar: true, ...ata, idempotencia: randomUUID() }).expect(201)).body;
    const invalido = (modelo_id: string, mapa: Record<string,string>) => ({ configuracao: { ...configuracao, antecedentes: [{ modelo_id, campos: mapa }] }, finalidade: 'EDITAL', tipo: 'OUTRO', revisao: 1, idempotencia: randomUUID() });
    await post('modelos/'+m.id+'/versoes').send(invalido(destino.id, campos)).expect(400);
    await post('modelos/'+m.id+'/versoes').send(invalido(m.id, {})).expect(400);
    await post('modelos/'+destino.id+'/versoes').send(invalido(m.id, { [pauta]: data })).expect(400);
    await post('modelos','outra').send({ publicar: true, ...ata, contexto_id: contextoOutra, configuracao: { ...config, antecedentes: [{ modelo_id: m.id, campos: {} }] }, idempotencia: randomUUID() }).expect(400);

    // Acervo de entrada já expedido. A tramitação de assinatura tem suíte própria.
    async function exemplar(assunto: string, itens: string[], restrito = false, comData = true, modelo = m.versao_id, numero?: number) {
      const v = versao(modelo,null);
      v.conteudo.teor = '';
      v.conteudo.composicao = (modelo === alternativo.versao_id ? configAlternativa : configuracao).composicao_padrao;
      v.conteudo.valores = { [modelo === alternativo.versao_id ? atividades : pauta]: { tipo: 'texto', multiplo: true, valor: itens, origem: { tipo: 'manual' }, ajustado_manualmente: true } };
      if (comData) v.conteudo.valores[data] = { tipo: 'data', multiplo: false, valor: '2026-01-09', origem: { tipo: 'manual' }, ajustado_manualmente: true };
      const d = await p.documento.create({ data: { igreja_id: igreja, contexto_id: contexto, tipo: 'OUTRO', perfil: 'CORRESPONDENCIA', estado: 'EXPEDIDO', restrito, ...(numero && { numero, ano: 2026, sigla: 'AG' }),
        versoes: { create: { modelo_versao_id: modelo, reuniao_id: reuniao, numero: 1, assunto, data_documento: new Date(dia), conteudo: JSON.parse(JSON.stringify(v.conteudo)), congelado_em: new Date() } } }, include: { versoes: true } });
      return { documento: d.id, id: d.versoes[0].id };
    }
    const primeiro = await exemplar('Edital E4 ordinário', ['Abertura','Relatório','Eleição'], false, true, m.versao_id, 9876);
    const consulta = { contexto, visao: 'expedidos', modelo: m.id, busca: '9876/2026/AG', de: dia, ate: dia, estado: 'EXPEDIDO' };
    expect((await get('documentos/consulta').query(consulta).expect(200)).body.itens).toMatchObject([{ id: primeiro.documento, modelo_nome: edital.nome }]);
    expect((await get('documentos/consulta').query({ ...consulta, visao: 'andamento' }).expect(200)).body.itens).toEqual([]);
    const segundo = await exemplar('Edital E4 adicional', ['Exame'],false,false,alternativo.versao_id);
    const sigiloso = await exemplar('Edital E4 reservado', ['Reservado'],true);
    expect((await get('documentos/consulta').query({ ...consulta, busca: 'reservado' }).expect(200)).body.itens).toEqual([]);
    const outroModelo = await exemplar('Fora da cadeia', [],false,false,modeloVersao);
    const previa = (id: string, perfil = 'secretario', restrito = false) => post('antecedentes/previa',perfil)
      .send({ modelo_versao_id: destino.versao_id, reuniao_id: reuniao, origem_id: id, restrito });
    const lista = await get('motivadores').query({ modelo_destino: destino.versao_id, reuniao_id: reuniao, assunto: 'Edital E4' }).expect(200);
    expect(lista.body.itens.map(x => x.versao_id).sort()).toEqual([primeiro.id,segundo.id].sort());
    await previa(sigiloso.id).expect(404);
    await previa(sigiloso.id,'gestor',false).expect(400);
    await previa(sigiloso.id,'secretario',true).expect(403);
    await previa(sigiloso.id,'gestor',true).expect(403);
    await previa(primeiro.id,'outra').expect(400);
    await previa(outroModelo.id).expect(400);
    const externa = await p.documento_versao.findFirstOrThrow({ where: { igreja_id: outra } });
    await previa(externa.id).expect(400);
    await previa(primeiro.id,'auditor').expect(403);
    const valores = (await previa(primeiro.id).expect(200)).body.valores;
    expect(valores[pauta]).toMatchObject({ valor: ['Abertura','Relatório','Eleição'], origem: { tipo: 'documento_anterior', versao_id: primeiro.id, campo_id: pauta }, ajustado_manualmente: false });
    const v = versao(destino.versao_id);
    v.data_documento = '2026-01-11';
    v.conteudo.teor = '';
    const novo = () => post('documentos').send({ contexto_id: contexto, restrito: false, usar_modelo_vigente: true, versao: v, idempotencia: randomUUID() });
    await novo().expect(400);
    v.motivador_id = sigiloso.id;
    await novo().expect(404);
    v.motivador_id = outroModelo.id;
    await novo().expect(400);
    v.motivador_id = primeiro.id;
    const pautaLocal = { ...valores[pauta], origem: { tipo: 'manual' }, ajustado_manualmente: true, valor: ['Assunto próprio da ata'] };
    v.conteudo.valores = { [campoLocal.id]: pautaLocal, [data]: { ...valores[data], valor: '1999-12-31' } };
    const id = (await novo().expect(201)).body.id;
    v.conteudo = (await detalhe(id)).versoes[0].conteudo;
    expect(v.conteudo.valores).toEqual({ ...valores, [campoLocal.id]: pautaLocal });
    expect(v.conteudo.antecedente?.identificacao).toContain('Edital E4 ordinário');
    const editar = (revisao: number) => patch('documentos/'+id).send({ revisao, versao: v, idempotencia: randomUUID() });
    v.conteudo.valores![pauta] = { ...valores[pauta], valor: ['Pauta ajustada'], ajustado_manualmente: true };
    await editar(1).expect(200);
    const job = (await post('documentos/'+id+'/rascunhos').send({ revisao: 2 }).expect(201)).body;
    expect(await processarAte(job.id)).toMatchObject({ estado: 'CONCLUIDO' });
    const pdf = await get('documentos/'+id+'/rascunhos/'+job.id+'/arquivo').expect(200);
    const texto = execFileSync('pdftotext', ['-layout','-','-'], { input: pdf.body, encoding: 'utf8' });
    expect(texto).toContain('Pauta ajustada');
    expect(texto).toContain('Assunto próprio da ata');
    expect(texto).not.toMatch(/Recepcionado|Ajustado manualmente|Campo local do modelo/i);
    const retificacao = versao(m.versao_id,reuniao);
    retificacao.conteudo = { ...retificacao.conteudo, teor: '', composicao: configuracao.composicao_padrao,
      valores: { [pauta]: { tipo: 'texto', multiplo: true, origem: { tipo: 'manual' }, ajustado_manualmente: true, valor: ['Pauta retificada'] } } };
    const liberacao = process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS;
    try {
      process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS = '';
      await post('documentos/'+primeiro.documento+'/retificar','gestor').send({ ...cmd(1), versao: retificacao }).expect(409);
      expect((await detalhe(primeiro.documento)).estado).toBe('EXPEDIDO');
    } finally {
      if (liberacao === undefined) delete process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS;
      else process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS = liberacao;
    }
    const retificada = await post('documentos/'+primeiro.documento+'/retificar','gestor').send({ ...cmd(1), versao: retificacao }).expect(201);
    await previa((await detalhe(retificada.body.id)).versoes[0].id).expect(400);
    const reaberta = (await detalhe(id)).versoes[0];
    expect(reaberta.conteudo.valores[pauta]).toEqual(v.conteudo.valores![pauta]);
    expect(reaberta.conteudo.valores[campoLocal.id]).toEqual(pautaLocal);
    expect(reaberta.conteudo.antecedente).toMatchObject({ versao_id: primeiro.id, identificacao: expect.stringContaining('Edital E4 ordinário') });
    v.motivador_id = segundo.id;
    v.conteudo.valores = (await previa(segundo.id).expect(200)).body.valores;
    expect(v.conteudo.valores![pauta].origem).toMatchObject({ campo_id: atividades, versao_id: segundo.id });
    await editar(2).expect(409);
    expect((await detalhe(id)).versoes[0].motivador_id).toBe(primeiro.id);
    v.confirmar_troca_origem = true;
    await editar(2).expect(200);
    expect(v.conteudo.valores![data].valor).toBeNull();
    v.conteudo.valores![data] = { tipo: 'data', multiplo: false, valor: dia, origem: { tipo: 'documento_anterior', versao_id: segundo.id, campo_id: data }, ajustado_manualmente: true };
    await editar(3).expect(200);
    expect((await detalhe(id)).versoes[0].conteudo.valores[data]).toEqual(v.conteudo.valores![data]);
  });

  it('isola anexos e acervo restrito também em listas, logs e downloads', async () => {
    const upload = await request(app.getHttpServer()).post('/arquivos-privados').set('Cookie', cookies.gestor).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').attach('file', Buffer.from('anexo sintético'), 'anexo.txt').expect(201);
    const v = versao(); v.conteudo.anexos = [{ arquivo_id: upload.body.id, nome: 'evidencia.txt' }];
    await post('documentos').send({ contexto_id: contexto, restrito: false, versao: v, idempotencia: randomUUID() }).expect(400);
    await post('documentos', 'gestor').send({ contexto_id: contexto, restrito: true, versao: v, idempotencia: randomUUID() }).expect(403);
    const carta = (await post('modelos').send({ contexto_id: contexto, nome: 'Correspondência reservada', tipo: 'OUTRO', finalidade: 'CARTA',
      configuracao: { ...config, perfil: 'CORRESPONDENCIA', registro_livro: false }, publicar: true, idempotencia: randomUUID() }).expect(201)).body;
    const entradaRestrita = { contexto_id: contexto, restrito: true, versao: { ...v, modelo_versao_id: carta.versao_id, reuniao_id: null }, idempotencia: randomUUID() };
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
  it('preserva as demais colunas de uma ata finalizada ao alterar o sigilo', async () => {
    const dados = { igreja_id: igreja, contexto_id: contexto, estado: 'CANCELADO' as const, perfil: 'HISTORICO' };
    const ata = await p.documento.create({ data: { ...dados, tipo: 'ATA' } });
    const carta = await p.documento.create({ data: { ...dados, tipo: 'OUTRO' } });
    const classificar = { restrito: true, revisao: { increment: 1 } };
    await expect(p.documento.update({ where: { id: ata.id }, data: { ...classificar, versao_atual: 2 } })).rejects.toThrow();
    await expect(p.documento.update({ where: { id: ata.id }, data: { restrito: true } })).rejects.toThrow();
    await expect(p.documento.update({ where: { id: carta.id }, data: classificar })).rejects.toThrow();
    const mesmaAta = await p.documento.update({ where: { id: ata.id }, data: classificar });
    expect(mesmaAta).toEqual({ ...ata, restrito: true, revisao: 2 });
    await p.documento.update({ where: { id: ata.id }, data: { restrito: false, revisao: { increment: 1 } } });
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

  it('salva a página do modelo, herda a composição, reabre a edição e protege a revisão anterior', async () => {
    const espaco = { superior: 0, inferior: 0 };
    const nota = randomUUID();
    const composicao = {
      versao_formato: 1, pagina: {
        papel: 'A4', orientacao: 'retrato', fonte: 'Noto Sans', tamanho_pt: 12,
        margens_cm: { superior: 2, direita: 2, inferior: 2, esquerda: 2 },
        espacamento_cm: { cabecalho: espaco, corpo: espaco, rodape: espaco },
      }, cabecalho: [{ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'texto', texto: 'Cabeçalho fixo' }] }],
      rodape: [{ tipo: 'paragrafo', alinhamento: 'direita', trechos: [{ tipo: 'texto', texto: 'Rodapé fixo' }] }], notas: { [nota]: { texto: 'Referência do ofício.' } }, corpo: [
        { tipo: 'paragrafo', alinhamento: 'direita', trechos: [{ tipo: 'texto', texto: 'Ofício circular', negrito: true }, { tipo: 'referencia_nota', nota_id: nota }] },
      ],
    };
    const modelo = (await post('modelos').send({ publicar: true, contexto_id: contexto, nome: 'Ofício em página', tipo: 'OUTRO',
      finalidade: 'OFICIO', configuracao: { ...config, registro_livro: false, composicao_padrao: composicao }, idempotencia: randomUUID() }).expect(201)).body;
    const selecionado = (await get(`modelos?contexto=${contexto}`).expect(200)).body.find(m => m.id === modelo.id);
    expect(selecionado.versoes[0].configuracao.composicao_padrao).toEqual(composicao);
    const entrada = versao(modelo.versao_id, null);
    entrada.conteudo.teor = '';
    const comando = { contexto_id: contexto, restrito: false, usar_modelo_vigente: true, versao: entrada, idempotencia: randomUUID() };
    const salvo = (await post('documentos').send(comando).expect(201)).body;
    const id = salvo.id;
    await post('modelos/'+modelo.id+'/versoes').send({ revisao: 1, tipo: 'OUTRO', finalidade: 'OFICIO', configuracao: selecionado.versoes[0].configuracao, idempotencia: randomUUID() }).expect(201);
    expect((await post('documentos').send(comando).expect(201)).body).toEqual(salvo);
    await post('documentos').send({ ...comando, idempotencia: randomUUID() }).expect(409);
    expect(await detalhe(id)).toMatchObject({ estado: 'EM_EDICAO', numero: null, revisao: 1, versao_atual: 1 });
    expect(await p.documento_versao.count({ where: { modelo_versao_id: modelo.versao_id } })).toBe(1);
    expect((await detalhe(id)).versoes[0].conteudo.composicao).toEqual(composicao);
    const revisada = structuredClone(composicao);
    revisada.corpo[0].trechos[0].texto = 'Ofício revisado';
    revisada.corpo.push(...Array.from({ length: 80 }, (_, i) => ({ tipo: 'paragrafo', alinhamento: 'esquerda',
      trechos: [{ tipo: 'texto', texto: 'Parágrafo ' + (i + 1), negrito: false }],
    })));
    const dados = { revisao: 1, versao: { ...entrada, conteudo: { ...entrada.conteudo, composicao: revisada } } };
    await patch(`documentos/${id}`).send({ ...dados, idempotencia: randomUUID() }).expect(200);
    await patch(`documentos/${id}`).send({ ...dados, idempotencia: randomUUID() }).expect(409);
    expect((await detalhe(id)).versoes[0].conteudo.composicao).toEqual(revisada);
    await get(`documentos/${id}`, 'outra').expect(404);
    const job = (await post(`documentos/${id}/rascunhos`).send({ revisao: 2 }).expect(201)).body;
    expect(await processarAte(job.id)).toMatchObject({ estado: 'CONCLUIDO' });
    const arquivo = await get(`documentos/${id}/rascunhos/${job.id}/arquivo`).expect(200);
    const paginas = execFileSync('pdftotext', ['-layout', '-', '-'], { input: arquivo.body, encoding: 'utf8' }).trimEnd().split('\f');
    expect(paginas[0]).toContain('Ofício revisado');
    expect(paginas.length).toBeGreaterThan(1);
    expect(paginas[0]).toContain('1. Referência do ofício.');
    expect(paginas.slice(1).join('')).not.toContain('Referência do ofício.');
    for (const texto of paginas) {
      expect(texto).toContain('Cabeçalho fixo');
      expect(texto).toContain('Rodapé fixo');
    }
  }, 60000);

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
