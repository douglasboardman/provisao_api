import { NavegadorSecretaria } from './secretaria-navegador';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as pausa } from 'node:timers/promises';
import { PrismaClient, usuarios_perfil } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PDFDocument } from 'pdf-lib';
import request = require('supertest');
import { seedSecretaria } from '../prisma/seed-secretaria';
import { seedRegrasRelacaoEnum } from '../prisma/seed';

const habilitado = process.env.E10_INTEGRATION === '1' ? describe : describe.skip;
const origem = 'http://localhost:3001';
const base = 'http://127.0.0.1:3310';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const evidencia = { autoridade: 'Conselho de homologação', evidencia: 'Registro sintético de homologação' };
const comando = (revisao: number) => ({ ...evidencia, revisao, idempotencia: randomUUID() });
const senha = 'Senha-sintetica!E10';
const data = '2026-01-12';

async function aguardar<T>(descricao: string, consultar: () => Promise<T | undefined>, limiteMs = 30_000) {
  const inicio = Date.now();
  do {
    const resultado = await consultar();
    if (resultado !== undefined) return resultado;
    await pausa(150);
  } while (Date.now() - inicio < limiteMs);
  throw new Error('Tempo excedido: ' + descricao);
}

async function parar(processo?: ChildProcess, sinal: NodeJS.Signals = 'SIGTERM') {
  if (!processo || processo.exitCode !== null || processo.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => processo.kill('SIGKILL'), 7000);
    processo.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    processo.kill(sinal);
  });
}

async function rssArvore(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
  const atual = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
  const filhos = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');
  return (
    await Promise.all(
      filhos
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => rssArvore(Number(p))),
    )
  ).reduce((soma, filho) => soma + filho, atual);
}

habilitado('E10: homologação integrada com API, SMTP e worker reais', () => {
  const prisma = new PrismaClient();
  const igreja = randomUUID(),
    outra = randomUUID(),
    pastor = randomUUID();
  const emailPastor = `${pastor}@example.invalid`;
  const raiz = process.env.E10_ARTIFACTS ?? '';
  const storage = join(raiz, 'acervo');
  const http = request(base);
  let api: ChildProcess | undefined, worker: ChildProcess | undefined;
  let cookieAdmin = '',
    cookieGestor = '',
    cookieAuditor = '',
    cookieExterno = '';
  let usuarioAdmin: string, usuarioGestor: string;
  const cookiesOperacionais = new Map<usuarios_perfil, string>();
  const picos = { apiKiB: 0, workerComFilhosKiB: 0 };
  let coletor: NodeJS.Timeout | undefined;
  let logs = '';
  const apiRequest = (metodo: 'post' | 'get' | 'patch', caminho: string, cookie = cookieGestor) =>
    http[metodo](caminho).set('Cookie', cookie).set('Origin', origem).set('X-Provisao-Request', '1');
  let repeticoesPorConcorrencia = 0;
  async function post(caminho: string, dados: object, cookie = cookieGestor) {
    const enviar = () => apiRequest('post', caminho, cookie).send(dados);
    let resposta = await enviar();
    for (let tentativa = 1; tentativa <= 2 && resposta.status === 409 && 'idempotencia' in dados &&
      resposta.body.message === 'A Secretaria está processando operações concorrentes. Tente novamente.'; tentativa++) {
      await pausa(250 * tentativa);
      repeticoesPorConcorrencia++;
      resposta = await enviar();
    }
    if (resposta.status !== 201)
      throw new Error(`POST ${caminho}: HTTP ${resposta.status} ${JSON.stringify(resposta.body.message ?? '')}`);
    return resposta;
  }
  const get = (caminho: string, cookie = cookieGestor) => apiRequest('get', caminho, cookie).expect(200);
  const patch = (caminho: string, dados: object, cookie = cookieAdmin) =>
    apiRequest('patch', caminho, cookie).send(dados).expect(200);

  let contextosEditor = '*';
  function iniciar(entrada: string, smtpPort = process.env.E2E_SMTP_PORT ?? '51025') {
    const filho = spawn(process.execPath, [entrada], {
      env: {
        PATH: process.env.PATH,
        USER: process.env.USER,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        HOME: process.env.HOME,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        DATABASE_URL: process.env.DATABASE_URL,
        JWT_SECRET: 'e10-local-only',
        EMAIL_OUTBOX_KEY: '1'.repeat(64),
        MFA_ENCRYPTION_KEY: '2'.repeat(64),
        HOST: '127.0.0.1',
        PORT: '3310',
        PRIVATE_STORAGE_ROOT: storage,
        FRONTEND_URL: origem,
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: smtpPort,
        SMTP_FROM: 'provisao@example.invalid',
        SMTP_USER: process.env.E2E_SMTP_USER ?? '',
        SMTP_PASS: process.env.E2E_SMTP_PASS ?? '',
        FEATURE_GOVERNANCA: 'true',
        FEATURE_ORGAOS: 'true',
        FEATURE_ORGAOS_GESTAO: 'true',
        FEATURE_SECRETARIA: 'true',
        SECRETARIA_EDITOR_PAGINA_CONTEXTOS: contextosEditor,
        FEATURE_SECRETARIA_LIVROS: 'true',
        FEATURE_SECRETARIA_ASSINATURAS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [filho.stdout!, filho.stderr!])
      stream.on('data', (chunk) => {
        logs += chunk.toString();
      });
    return filho;
  }

  async function iniciarApi() {
    api = iniciar('dist/src/main.js');
    await aguardar('API em loopback', async () =>
      (await fetch(base + '/version').catch(() => null))?.ok ? true : undefined,
    );
  }

  async function login(igrejaId: string, email: string) {
    const resposta = await apiRequest('post', '/auth/login', '')
      .send({ igreja_id: igrejaId, login: email, senha })
      .expect(200);
    const cookies = resposta.headers['set-cookie'] as unknown as string[];
    return { id: resposta.body.sub as string, cookie: cookies[0].split(';')[0] };
  }

  async function tokenEmail(caminho: string) {
    return aguardar('e-mail entregue à caixa de homologação', async () => {
      const mailpit = `http://127.0.0.1:${Number(process.env.E2E_MAILPIT_PORT ?? 58025)}/api/v1`;
      const pesquisa = await fetch(`${mailpit}/search?query=${encodeURIComponent('to:' + emailPastor)}`);
      if (!pesquisa.ok) throw new Error('Caixa de homologação indisponível.');
      const lista: { messages: { ID: string }[] } = await pesquisa.json();
      for (const { ID } of lista.messages) {
        const mensagem: { Text: string; HTML: string } = await (await fetch(`${mailpit}/message/${ID}`)).json();
        const token = (mensagem.Text + mensagem.HTML).match(new RegExp(caminho + '([a-f0-9]{64})'))?.[1];
        if (token) return token;
      }
    });
  }

  beforeAll(async () => {
    if (
      !/^postgresql:\/\/provisao_test:provisao_test@127\.0\.0\.1:55439\/e10_fluxo_[a-f0-9]{8}\?schema=public$/.test(
        process.env.DATABASE_URL ?? '',
      ) ||
      !isAbsolute(raiz)
    )
      throw new Error('Use o banco descartável e o diretório privado do roteiro E10.');
    await mkdir(storage, { mode: 0o700 });
    await seedRegrasRelacaoEnum(prisma);
    const totalRegras = await prisma.relacao_enum_valores.count();
    await seedRegrasRelacaoEnum(prisma);
    expect(await prisma.relacao_enum_valores.count()).toBe(totalRegras);
    await prisma.igreja.createMany({
      data: [
        { id: igreja, nome: 'Igreja de homologação E10' },
        { id: outra, nome: 'Segunda igreja E10' },
      ],
    });
    const hash = await bcrypt.hash(senha, 4);
    async function ator(igrejaId: string, perfil: usuarios_perfil) {
      const email = `${randomUUID()}@example.invalid`;
      await prisma.usuarios.create({
        data: { igreja_id: igrejaId, perfil, nome_usuario: perfil, email_login: email, senha_hash: hash },
      });
      return email;
    }
    const adminEmail = await ator(igreja, 'ADMINISTRADOR');
    const auditorEmail = await ator(igreja, 'AUDITOR');
    const externoEmail = await ator(outra, 'ADMINISTRADOR');
    const perfisOperacionais = ['COMUM'] as const;
    const emailsOperacionais = await Promise.all(perfisOperacionais.map((perfil) => ator(igreja, perfil)));
    await iniciarApi();
    ({ id: usuarioAdmin, cookie: cookieAdmin } = await login(igreja, adminEmail));
    ({ cookie: cookieAuditor } = await login(igreja, auditorEmail));
    ({ cookie: cookieExterno } = await login(outra, externoEmail));
    for (const [indice, perfil] of perfisOperacionais.entries())
      cookiesOperacionais.set(perfil, (await login(igreja, emailsOperacionais[indice])).cookie);
    coletor = setInterval(() => {
      if (api?.pid)
        void rssArvore(api.pid).then((rss) => {
          picos.apiKiB = Math.max(picos.apiKiB, rss);
        });
      if (worker?.pid)
        void rssArvore(worker.pid).then((rss) => {
          picos.workerComFilhosKiB = Math.max(picos.workerComFilhosKiB, rss);
        });
    }, 150);
  }, 30_000);

  afterAll(async () => {
    clearInterval(coletor);
    await Promise.all([parar(worker), parar(api)]);
    await prisma.$disconnect();
    if (api) await writeFile(join(raiz, 'processos.log'), logs, { mode: 0o600 });
  });

  it('atravessa acesso, autoridade, livro e assinaturas; recupera a fila e preserva a cadeia', async () => {
    expect((await get('/igrejas/me', cookieAdmin)).body.id).toBe(igreja);
    expect((await get('/igrejas/me', cookieExterno)).body.id).toBe(outra);
    await post(
      '/auth/register',
      { igreja_id: igreja, nome_usuario: 'Pastor de homologação', email_login: emailPastor },
      '',
    );
    const solicitacao = await prisma.solicitacao_acesso.findFirstOrThrow({
      where: { igreja_id: igreja, email_login: emailPastor },
    });
    const emailJob = await prisma.outbox_email.findFirstOrThrow({
      where: { confirmacao: { solicitacao_id: solicitacao.id } },
    });
    worker = iniciar('dist/src/worker.js', '1');
    await aguardar('falha SMTP e reagendamento', async () => {
      const fila = await prisma.outbox_email.findUniqueOrThrow({ where: { id: emailJob.id } });
      return fila.estado === 'PENDENTE' && fila.tentativas === 1 && fila.ultimo_erro ? fila : undefined;
    });
    await parar(worker);
    await prisma.outbox_email.update({ where: { id: emailJob.id }, data: { proxima_tentativa: new Date() } });
    worker = iniciar('dist/src/worker.js');
    const confirmacao = await tokenEmail('/auth/confirm-access\\?token=');
    await apiRequest('get', '/auth/confirm-access', '').query({ token: confirmacao }).expect(404);
    await apiRequest('post', '/auth/confirm-access', '').send({ token: confirmacao }).expect(200);
    await apiRequest('post', '/auth/confirm-access', '').send({ token: confirmacao }).expect(401);
    await apiRequest('patch', `/solicitacoes-acesso/${solicitacao.id}/aprovar`, cookieExterno).expect(404);
    await patch(`/solicitacoes-acesso/${solicitacao.id}/aprovar`, {});
    const tokenSenha = await tokenEmail('/auth/set-password\\?token=');
    await apiRequest('post', '/auth/set-password', '').send({ token: tokenSenha, nova_senha: senha }).expect(200);
    ({ id: usuarioGestor, cookie: cookieGestor } = await login(igreja, emailPastor));
    await apiRequest('get', '/oficiais').expect(403);
    await patch(`/usuarios/${usuarioGestor}`, { perfil: 'COMUM' });
    ({ cookie: cookieGestor } = await login(igreja, emailPastor));

    const membros = [randomUUID(), randomUUID()];
    await prisma.pessoas.createMany({
      data: [pastor, ...membros].map((id) => ({
        id,
        igreja_id: igreja,
        nome_completo: id === pastor ? 'João de Araújo' : 'Pessoa de homologação',
        email: id === pastor ? emailPastor : undefined,
        data_nascimento: new Date('1980-01-01'),
        sexo: 'MASCULINO',
      })),
    });
    await patch(`/usuarios/${usuarioGestor}/pessoa`, { pessoa_id: pastor });
    ({ cookie: cookieGestor } = await login(igreja, emailPastor));
    const sessoes = new Map<usuarios_perfil, string>([
      ['ADMINISTRADOR', cookieAdmin],
      ['AUDITOR', cookieAuditor],
      ['COMUM', cookieGestor],
      ...cookiesOperacionais,
    ]);
    for (const [perfil, cookie] of sessoes) {
      for (const rota of ['/pessoas', '/eventos-membresia', '/contas', '/lancamentos/balanco', '/igrejas/me', '/usuarios'])
        await apiRequest('get', rota, cookie).expect(perfil === 'ADMINISTRADOR' ? 200 : 403);
      await get('/secretaria/contextos', cookie);
      for (const rota of ['/pessoas', '/eventos-membresia', '/lancamentos'])
        await apiRequest('post', rota, cookie).send({}).expect(perfil === 'ADMINISTRADOR' ? 400 : 403);
    }
    const oficial = (await post('/oficiais', { pessoa_id: pastor, tipo: 'PRESBITERO_DOCENTE' })).body.id;
    await post(`/oficiais/${oficial}/eventos`, {
      ...evidencia,
      tipo: 'ORDENACAO',
      data_efeito: '2019-01-12',
      ordem: 1,
    });
    await post(`/oficiais/${oficial}/vinculos-pastorais`, {
      modalidade: 'Pastor',
      concilio: evidencia.autoridade,
      ato: 'Vínculo registrado',
      data_inicio: '2020-01-12',
      exercicio_institucional: true,
      evidencia: evidencia.evidencia,
    });
    const conselho = (
      await post(
        '/orgaos/gestao/oficiais',
        {
          idempotencia: randomUUID(),
          tipo: 'CONSELHO',
          nome: 'Conselho',
          sigla: 'CS',
          finalidade: 'Governo da igreja',
          data_criacao: '2020-01-12',
        },
        cookieAdmin,
      )
    ).body.id;
    const presidencia = (await post(
      '/orgaos/gestao/presidencias',
      { oficial_id: oficial, inicio: '2020-01-12', evidencia: evidencia.evidencia, idempotencia: randomUUID() },
      cookieAdmin,
    )).body.id;
    const entradaUnidade = {
      nome: 'Unidade de ação social',
      sigla: 'UAS',
      finalidade: 'Serviço',
      constituicao: 'DESIGNACAO',
      data_criacao: data,
      evidencia: evidencia.evidencia,
      idempotencia: randomUUID(),
    };
    await apiRequest('post', '/orgaos/gestao/unidades').send(entradaUnidade).expect(403);
    await post(
      '/orgaos/gestao/competencias',
      { ...evidencia, usuario_id: usuarioGestor, inicio: '2020-01-12', idempotencia: randomUUID() },
      cookieAdmin,
    );
    const unidade = (await post('/orgaos/gestao/unidades', entradaUnidade)).body.id;
    for (const pessoa_id of membros)
      await post('/eventos-membresia', {
        pessoa_id,
        tipo_evento: 'ADMISSAO',
        rol: 'COMUNGANTES',
        motivacao_evento: 'PROFISSAO_DE_FE',
        referencia_documental: 'Ata nº 1/2020',
        data_evento: '2020-01-12',
      });
    const lider = await prisma.cargo_orgao.findFirstOrThrow({ where: { orgao_id: unidade, codigo: 'LIDER' } });
    const hoje = (await get('/orgaos/relogio')).body.data_operacional;
    for (const [indice, pessoa_id] of membros.entries())
      await post(`/orgaos/gestao/${unidade}/cargos/${lider.id}/designacoes`, {
        pessoa_id,
        data_efeito: hoje,
        ordem_efeito: indice + 1,
        evidencia: evidencia.evidencia,
        idempotencia: randomUUID(),
      });
    const ocupacoes = await prisma.ocupacao_cargo.findMany({
      where: { cargo_id: lider.id },
      orderBy: { inicio_ordem: 'asc' },
    });
    expect(ocupacoes.map((o) => [o.pessoa_id, o.fim_ordem])).toEqual([
      [membros[0], 2],
      [membros[1], null],
    ]);

    const s = '/secretaria';
    const contexto = (
      await post(
        s + '/contextos',
        {
          tipo: 'ORGAO',
          orgao_id: conselho,
          nome: 'Conselho',
          sigla: 'CS',
          idempotencia: randomUUID(),
        },
        cookieAdmin,
      )
    ).body.id;
    await post(
      s + '/competencias',
      {
        ...evidencia,
        contexto_id: contexto,
        usuario_id: usuarioGestor,
        inicio: '2020-01-12',
        idempotencia: randomUUID(),
        pode_aprovar: true,
        pode_deliberar: true,
        pode_consultar_restritos: true,
      },
      cookieAdmin,
    );
    const cargoSecretario = await prisma.cargo_orgao.findFirstOrThrow({ where: { orgao_id: conselho, codigo: 'SECRETARIO' } });
    // O ensaio parte de uma posse histórica comprovada na fixture. O ato de eleição exige ata e outro operador.
    await prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: conselho, cargo_id: cargoSecretario.id,
      pessoa_id: pastor, inicio: new Date('2020-01-12') } });
    await prisma.usuarios.update({ where: { id: usuarioGestor }, data: { conta_atuacao: true } });
    await prisma.evento_autorizacao.create({ data: { igreja_id: igreja, operador_id: usuarioAdmin, pessoa_id: pastor,
      acao: 'PRESIDENCIA_CONFERIDA', recurso_id: presidencia, fundamento: evidencia.evidencia, dados: {} } });
    const modelos = await seedSecretaria(prisma, igreja, contexto, usuarioAdmin);
    expect(await seedSecretaria(prisma, igreja, contexto, usuarioAdmin)).toEqual(modelos);
    expect(await prisma.modelo_documento.count({ where: { contexto_id: contexto } })).toBe(4);
    await expect(seedSecretaria(prisma, outra, contexto, usuarioAdmin)).rejects.toThrow();
    const mesa = { pessoa_id: pastor, presente: true, papeis: ['PRESIDENTE', 'SECRETARIO'] };
    const local = await prisma.local_reuniao.create({
      data: { igreja_id: igreja, descritivo: 'Templo de homologação' },
    });
    const agendamento = {
      restrito: true,
      modalidade: 'REGULAR',
      situacao: 'AGENDADA',
      data: hoje,
      horario_previsto: '10:00',
      itens_pauta: [{ descricao: 'Admissão de membros', proponente_id: null }],
    };
    const reuniao = (
      await post(s + '/reunioes', {
        contexto_id: contexto,
        local_id: local.id,
        idempotencia: randomUUID(),
        dados: agendamento,
      })
    ).body.id;
    const livro = (
      await post(s + '/livros', {
        contexto_id: contexto,
        idempotencia: randomUUID(),
        numero: 10,
        serie: 'ATA_PADRAO',
        modalidade: 'PARA_ENCADERNACAO',
        perfil: 'LOCAL_V1',
        capacidade_folhas: 20,
        faces_por_folha: 1,
        reserva_exame: 1,
        fonte_normativa: 'Regimento sintético',
        restrito: true,
      })
    ).body.id;
    const livroUrl = `${s}/livros/${livro}`;
    await apiRequest('get', livroUrl, cookieAuditor).expect(404);
    const livroDetalhe = async () => (await get(livroUrl)).body;
    const resolucoes = [
      {
        ordem: 1,
        assunto: 'Verificação da admissão',
        texto_proposta: null,
        texto_deliberado: 'Aprovada a admissão registrada.',
        resultado: 'APROVADA',
        eficaz: true,
        data_efeito: null,
        votacao_secreta: false,
        apuracao: null,
        proponentes_pessoas_ids: [],
        dissidentes_pessoas_ids: [],
      },
    ];
    const arrolados = [
      {
        pessoa_id: pastor,
        papeis: mesa.papeis,
        assina: true,
        obrigatorio: true,
        responsavel: true,
        fundamento: 'Mesa competente',
      },
    ];
    async function aprovar(
      modelo: string,
      assunto: string,
      teor: string,
      tipo: 'FISICA' | 'ELETRONICA',
      vinculos: { emLivro?: boolean; reuniao?: 'edital' | 'ata'; antecedente?: string } = {},
    ) {
      const ata = vinculos.reuniao === 'ata';
      const emLivro = !!vinculos.emLivro;
      const id = (
        await post(s + '/documentos', {
          contexto_id: contexto,
          restrito: emLivro || !!vinculos.reuniao,
          idempotencia: randomUUID(),
          versao: {
            modelo_versao_id: modelo,
            livro_id: emLivro ? livro : null,
            reuniao_id: vinculos.reuniao ? reuniao : null,
            motivador_id: vinculos.antecedente ?? null,
            assunto,
            data_documento: hoje,
            conteudo: { teor, campos: {}, anexos: [], arrolados, ...(ata && { redator_ata: { pessoa_id: pastor } }) },
            ...(ata ? { resolucoes } : {}),
          },
        })
      ).body.id;
      const url = s + '/documentos/' + id;
      await post(url + '/encaminhar', comando(1));
      if (ata) await post(url + '/deliberar', { ...comando(2), reuniao_id: reuniao, resultado: 'APROVADA', data: hoje });
      const revisao = ata ? 3 : 2;
      let paginas: number | undefined;
      if (emLivro) {
        const medicao = (await post(url + '/medicao-livro', { revisao })).body.id;
        paginas = await aguardar('medição pelo worker real', async () => {
          const job = await prisma.trabalho_renderizacao.findUniqueOrThrow({ where: { id: medicao } });
          if (job.estado === 'FALHOU') throw new Error('Falha na medição.');
          return job.paginas_medidas ?? undefined;
        });
      }
      await post(url + '/aprovar', { ...comando(revisao), modalidade: tipo });
      const detalhe = (await get(url)).body;
      const versao = detalhe.versoes[0];
      const assinatura = url + '/assinaturas';
      const job = await aguardar('matriz pelo worker real', async () => {
        const job = await prisma.trabalho_renderizacao.findFirstOrThrow({
          where: { versao_id: versao.id, finalidade: 'MATRIZ_APROVADA' },
          include: { arquivo: true },
        });
        if (job.estado === 'FALHOU') throw new Error('Falha na matriz.');
        return job.estado === 'CONCLUIDO' ? job : undefined;
      });
      const matriz = (await get(`${url}/artefatos/${job.id}/arquivo`)).body as Buffer;
      expect(sha(matriz)).toBe(job.arquivo?.sha256);
      return {
        id,
        url,
        assinatura,
        versaoId: versao.id as string,
        arroladoId: versao.arrolados[0].id as string,
        revisao: detalhe.revisao as number,
        matriz,
        paginas,
      };
    }
    type Aprovado = Awaited<ReturnType<typeof aprovar>>;
    const arquivo = (d: Aprovado, tipo: string) => `${d.assinatura}/${d.versaoId}/arquivos/${tipo}`;
    const expedir = async (d: Aprovado, nome: string) => {
      const final = await aguardar('expedição pelo worker real', async () => {
        const detalhe = (await get(d.url)).body;
        return detalhe.estado === 'EXPEDIDO' ? ((await get(arquivo(d, 'final'))).body as Buffer) : undefined;
      });
      expect((await get(arquivo(d, 'final'))).body).toEqual(final);
      await writeFile(join(raiz, nome + '.pdf'), final);
      const item = (await get(d.assinatura)).body[0];
      expect((await get('/assinaturas/verificacao/' + item.codigo, '')).body.sha256).toBe(sha(final));
      return final;
    };
    async function coletaFisica(d: Aprovado, salvarVia?: string) {
      const dados = { versao_id: d.versaoId, revisao: d.revisao };
      await post(d.assinatura + '/via', { ...dados, idempotencia: randomUUID() });
      const via = (await get(arquivo(d, 'via'))).body as Buffer;
      if (salvarVia) await writeFile(join(raiz, salvarVia + '.pdf'), via);
      const scan = await PDFDocument.load(via);
      scan.getPages().at(-1)!.drawText('Rubrica sintetica E10', { x: 80, y: 45, size: 9 });
      const bytes = Buffer.from(await scan.save());
      await apiRequest('post', d.assinatura + '/fisica/conferir')
        .field(
          'dados',
          JSON.stringify({
            ...dados,
            idempotencia: randomUUID(),
            via_sha256: sha(via),
            evidencia: 'Original sintético conferido',
            assinaturas: [{ arrolado_id: d.arroladoId, data: hoje, evidencia: 'Rubrica conferida' }],
          }),
        )
        .attach('file', bytes, 'scan.pdf')
        .expect(201);
      return bytes;
    }

    const abertura = await aprovar(
      modelos.TERMO_ABERTURA,
      'Termo de Abertura',
      'Abre-se o livro para registro das atas do Conselho.',
      'FISICA',
      { emLivro: true },
    );
    expect((await livroDetalhe()).estado).toBe('EM_PREPARACAO');
    const scan = await coletaFisica(abertura, '01-abertura-via-fisica');
    await expedir(abertura, '02-abertura');
    expect((await get(arquivo(abertura, 'scan'))).body).toEqual(scan);
    expect((await livroDetalhe()).estado).toBe('ABERTO');

    const campos = (await get(s + '/campos')).body as { id: string; codigo: string; origem: string }[];
    const campo = (codigo: string) => campos.find((c) => c.codigo === codigo)!.id;
    const espaco = { superior: 0, inferior: 0 };
    const pagina = {
      papel: 'A4',
      orientacao: 'retrato',
      fonte: 'Noto Serif',
      tamanho_pt: 12,
      margens_cm: { superior: 2, inferior: 2, esquerda: 2, direita: 2 },
      espacamento_cm: { cabecalho: espaco, corpo: espaco, rodape: espaco },
    };
    const paragrafo = (texto: string) => ({
      tipo: 'paragrafo',
      alinhamento: 'esquerda',
      trechos: [{ tipo: 'texto', texto }],
    });
    const valor = (id: string, apresentacao = 'em_linha') => ({
      tipo: 'paragrafo',
      alinhamento: 'esquerda',
      trechos: [{ tipo: 'campo', campo_id: id, apresentacao }],
    });
    const compor = (corpo: object[]) => ({ versao_formato: 1, pagina, corpo, cabecalho: [], rodape: [], notas: {} });
    const modelo = (nome: string, tipo: string, finalidade: string, config: object) =>
      post(s + '/modelos', {
        nome,
        tipo,
        finalidade,
        publicar: true,
        idempotencia: randomUUID(),
        contexto_id: contexto,
        configuracao: {
          contexto: 'ORGAO',
          tipos_orgao: ['CONSELHO'],
          constituicoes: ['OFICIAL'],
          perfil: 'ATA_PADRAO',
          motivador: 'OPCIONAL',
          resolucoes: 'OPCIONAL',
          cargos_obrigatorios: [],
          campos_obrigatorios: [],
          papeis_obrigatorios: [],
          ...config,
        },
      });
    const editalModelo = (
      await modelo('Edital do Conselho', 'OUTRO', 'CONVOCACAO', {
        atuacao: { criar: ['PRESIDENCIA_CONSELHO'], preparar: [], assinar: [] },
        vinculo_reuniao: 'OBRIGATORIO',
        composicao_padrao: compor([paragrafo('Convocação do Conselho'), valor(campo('PAUTA_REUNIAO'))]),
      })
    ).body;
    const edital = await aprovar(editalModelo.versao_id, 'Convocação do Conselho', '', 'FISICA', { reuniao: 'edital' });
    await coletaFisica(edital);
    await expedir(edital, 'edital-conselho');
    const fichaReuniao = (await get(s + '/reunioes/' + reuniao)).body;
    const item = fichaReuniao.itens_pauta[0];
    await patch(
      s + '/reunioes/' + reuniao,
      {
        revisao: fichaReuniao.revisao,
        idempotencia: randomUUID(),
        local_id: local.id,
        dados: {
          ...agendamento,
          situacao: 'ENCERRADA',
          inicio: hoje + 'T10:00:00-03:00',
          fim: hoje + 'T11:00:00-03:00',
          itens_pauta: [{ id: item.id, descricao: item.descricao, proponente_id: null }],
          competencia: 'Conselho',
          universo_informado: 1,
          quorum_minimo: 1,
          quorum_conferido: true,
          fundamento_quorum: 'Mesa conferiu',
          resultado: 'Apreciada',
          participantes: [mesa],
        },
      },
      cookieGestor,
    );
    const recebida = campo('PAUTA');
    const decisao = campos.find((c) => c.origem === 'deliberacoes_reuniao')!.id;
    const ataModelo = (
      await modelo('Ata encadeada do Conselho', 'ATA', 'ATA_REUNIAO', {
        atuacao: { criar: [cargoSecretario.id], preparar: [], assinar: [] },
        registro_em_livro: 'OBRIGATORIO',
        antecedentes: [{ modelo_id: editalModelo.id, campos: { [recebida]: campo('PAUTA_REUNIAO') } }],
        composicao_padrao: compor([
          valor(campo('LOCAL_REUNIAO'), 'individual'),
          valor(recebida),
          ...Array.from({ length: 36 }, (_, i) =>
            paragrafo(
              i +
                1 +
                '. A comissão apresentou a prestação de contas e as ações de assistência. Após discussão, a presidência determinou o registro integral da deliberação e da verificação em reunião.',
            ),
          ),
          paragrafo('Decisões da sessão'),
          valor(decisao),
          paragrafo('Encerramento da sessão'),
        ]),
      })
    ).body;

    const inicioLote = Date.now();
    const latencias: number[] = [];
    let ler = true;
    const leitor = async () => {
      while (ler) {
        const inicio = Date.now();
        await get('/igrejas/me');
        latencias.push(Date.now() - inicio);
        await pausa(120);
      }
    };
    const leituras = Promise.all([leitor(), leitor(), leitor(), leitor()]);
    let ata: Aprovado;
    try {
      [ata] = await Promise.all([
        aprovar(
          ataModelo.versao_id, 'Ata de reunião ordinária', '', 'ELETRONICA', { emLivro: true, reuniao: 'ata', antecedente: edital.versaoId },
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          aprovar(
            modelos.CORRESPONDENCIA,
            `Correspondência ${i + 1}`,
            'À Comissão de Ação Social. Encaminhamos a comunicação de homologação à sua apreciação.',
            'FISICA',
          ).then(async (d) => {
            await coletaFisica(d);
            return expedir(d, `correspondencia-${i + 1}`);
          }),
        ),
      ]);
    } finally {
      ler = false;
      await leituras;
    }
    const loteMs = Date.now() - inicioLote;
    expect(ata.paginas).toBeGreaterThan(1);
    latencias.sort((a, b) => a - b);
    expect(latencias.length).toBeGreaterThan(10);
    expect((await get(ata.url)).body.versoes[0].resolucoes[0].proponentes).toEqual([]);
    await apiRequest('get', ata.url, cookieAuditor).expect(404);
    await apiRequest('get', ata.url, cookieExterno).expect(404);
    await post(ata.assinatura + '/convidar', {
      versao_id: ata.versaoId,
      revisao: ata.revisao,
      arrolado_id: ata.arroladoId,
      evidencia: 'Canal individual conferido',
      canal_individual: true,
      idempotencia: randomUUID(),
    });
    const convite = await tokenEmail('/assinaturas/convite#');
    // Pausa do editor para novas criações. A sessão e o convite já emitido atravessam o reinício.
    await parar(api);
    contextosEditor = '';
    await iniciarApi();
    const bloqueada = await apiRequest('post', s + '/documentos').send({
      contexto_id: contexto, restrito: true, idempotencia: randomUUID(),
      versao: { modelo_versao_id: ataModelo.versao_id, livro_id: livro, reuniao_id: reuniao, motivador_id: edital.versaoId,
        data_documento: hoje, assunto: 'Nova minuta durante a pausa', conteudo: { teor: '', arrolados, campos: {}, anexos: [] } },
    }).expect(409);
    expect(bloqueada.body.message).toContain('pausado');
    await apiRequest('get', '/assinaturas/convite/decisao', '').expect(404);
    const aceite = (await post('/assinaturas/convite/consulta', { token: convite })).body;
    const escopo = { token: convite, versao_id: ata.versaoId, manifesto_sha256: aceite.manifesto_sha256 };
    const leitura = (await post('/assinaturas/convite/arquivo', escopo)).body as Buffer;
    expect(leitura).toEqual(ata.matriz);
    expect(sha(leitura)).toBe(aceite.matriz_sha256);
    await writeFile(join(raiz, '03-ata-matriz.pdf'), leitura);
    // A expedição tenta ler o acervo com a permissão inválida e volta à fila.
    await parar(worker);
    await post('/assinaturas/convite/decisao', { ...escopo, decisao: 'ASSINAR', consentimento: true });
    await chmod(storage, 0o755);
    try {
      worker = iniciar('dist/src/worker.js');
      await aguardar('storage recusado e expedição reagendada', async () => {
        const e = await prisma.expedicao_documento.findUniqueOrThrow({ where: { versao_id: ata.versaoId } });
        return e.estado === 'PENDENTE' && e.tentativas === 1 ? e : undefined;
      });
      expect((await get(ata.url)).body.estado).toBe('APROVADO');
    } finally {
      await chmod(storage, 0o700);
    }
    await parar(worker, 'SIGKILL');
    await prisma.expedicao_documento.update({
      where: { versao_id: ata.versaoId },
      data: { executar_apos: new Date() },
    });
    worker = iniciar('dist/src/worker.js');
    const finalAta = await expedir(ata, '04-ata-expedida');
    const documentoExpedido = (await get(ata.url)).body;
    expect(documentoExpedido).toMatchObject({ numero: 1, identificacao_livro: expect.stringContaining('Livro nº 10') });
    const expedida = documentoExpedido.versoes[0];
    expect(expedida.conteudo.valores[recebida]).toMatchObject({
      valor: [item.descricao],
      origem: { tipo: 'documento_anterior', versao_id: edital.versaoId },
    });
    const textoAta = execFileSync('pdftotext', ['-layout', '-', '-'], { input: finalAta, encoding: 'utf8' });
    expect(textoAta).toMatch(
      /Admissão de membros[\s\S]+Decisões da sessão[\s\S]+Aprovada a admissão registrada[\s\S]+Encerramento da sessão/,
    );
    expect(textoAta.match(/Aprovada a admissão registrada/g)).toHaveLength(1);
    await prisma.local_reuniao.update({ where: { id: local.id }, data: { descritivo: 'Novo nome após a sessão' } });
    expect((await get(ata.url)).body.versoes[0].conteudo.valores[recebida]).toEqual(
      expedida.conteudo.valores[recebida],
    );
    const campoLocal = (await get(ata.url)).body.versoes[0].conteudo.valores[campo('LOCAL_REUNIAO')];
    expect(campoLocal.valor).toBe(local.descritivo);
    expect(campoLocal).toEqual(expedida.conteudo.valores[campo('LOCAL_REUNIAO')]);
    expect(textoAta).toContain(local.descritivo);
    const revisaoFinal = (await get(ata.url)).body.revisao;
    const pedidoVia = { versao_id: ata.versaoId, revisao: revisaoFinal, idempotencia: randomUUID() };
    await post(ata.assinatura + '/via', pedidoVia);
    await post(ata.assinatura + '/via', pedidoVia);
    expect((await get(arquivo(ata,'via'))).body).not.toEqual(finalAta);
    expect((await get(arquivo(ata,'final'))).body).toEqual(finalAta);
    const registrosAta = await prisma.registro_livro.findMany({ where: { versao_id: ata.versaoId } });
    expect(registrosAta).toHaveLength(1);
    expect(registrosAta[0].estado).toBe('EFETIVADO');
    expect(await prisma.assinatura_documento.count({ where: { versao_id: ata.versaoId } })).toBe(1);
    await apiRequest('post', '/assinaturas/convite/decisao')
      .send({ ...escopo, decisao: 'ASSINAR', consentimento: true })
      .expect(404);

    const evento = await prisma.eventos_membresia.findFirstOrThrow({ where: { pessoa_id: membros[0] } });
    const referencia = `${s}/referencias-ata/MEMBRESIA/${evento.id}/ATO`;
    expect((await get(referencia)).body.situacao).toBe('PENDENTE');
    await post(referencia, {
      ata_documento_id: ata.id,
      versao_id: ata.versaoId,
      justificativa: 'Ata conferida',
      revisao_esperada: null,
    });
    expect((await get(referencia)).body.situacao).toBe('FORMALIZADA');
    expect((await get(ata.url + '/registros-vinculados')).body.itens).toHaveLength(1);
    const historico = await prisma.eventos_membresia.findFirstOrThrow({ where: { pessoa_id: membros[1] } });
    await post(`${s}/referencias-ata/MEMBRESIA/${historico.id}/ATO`, {
      referencia_externa: {
        concilio: 'Conselho',
        identificacao: 'Ata histórica 01',
        data: '2020-01-12',
        localizacao: 'Livro físico 01',
        conferida: true,
      },
      justificativa: 'Original conferido',
      revisao_esperada: null,
    });
    expect((await get(`${s}/referencias-ata/MEMBRESIA/${historico.id}/ATO`)).body.situacao).toBe('EXTERNA_CONFERIDA');
    await parar(api);
    contextosEditor = '*';
    await iniciarApi();
    await post(livroUrl + '/acoes/preparar-encerramento', {
      ...comando((await livroDetalhe()).revisao),
      motivo: 'Homologação concluída',
    });
    const encerramento = await aprovar(
      modelos.TERMO_ENCERRAMENTO,
      'Termo de Encerramento',
      'Encerram-se os registros deste livro.',
      'FISICA',
      { emLivro: true },
    );
    await coletaFisica(encerramento);
    await expedir(encerramento, '05-encerramento');
    const volume = await livroDetalhe();
    expect(volume).toMatchObject({ estado: 'ENCERRADO', totais: { total_atas: 1 } });
    const manifesto = await get(livroUrl + '/arquivos/manifesto');
    expect(sha(Buffer.from(manifesto.text))).toBe(volume.manifesto_sha256);
    const compilacao = (await get(livroUrl + '/arquivos/compilacao')).body as Buffer;
    await writeFile(join(raiz, '06-livro-compilado.pdf'), compilacao);
    if (process.env.E10_NAVEGADOR === '1') {
      const navegador = await NavegadorSecretaria.abrir();
      try {
        const registro = JSON.parse(manifesto.text).registros.find((r: { arquivo_id: string }) => r.arquivo_id === registrosAta[0].arquivo_id);
        await navegador.conferirAcervo(contexto, cookieGestor, finalAta, registro.sha256, Buffer.from(manifesto.text), compilacao);
      } finally {
        await navegador.fechar();
      }
    }
    const conta = await prisma.contas.create({
      data: { igreja_id: igreja, descricao: 'Caixa de teste', tipo_conta: 'CAIXA', saldo_inicial: 100 },
    });
    for (const [tipo, valor] of [
      ['RECEITA', 125.45],
      ['DESPESA', 30.25],
    ] as const)
      await post(
        '/lancamentos',
        {
          conta_id: conta.id,
          tipo_transacao: tipo,
          valor,
          data_transacao: data,
        },
        cookieAdmin,
      );
    expect((await get('/lancamentos/balanco?mes=1&ano=2026')).body).toMatchObject({
      total_receitas: 125.45,
      total_despesas: 30.25,
      saldo: 95.2,
    });
    expect((await get('/lancamentos/balanco?mes=1&ano=2026', cookieExterno)).body).toMatchObject({ saldo: 0 });
    const arquivosPrivados = await prisma.arquivo_privado.findMany({ select: { id: true } });
    expect((await readdir(storage)).sort()).toEqual(arquivosPrivados.map((a) => a.id).sort());
    await writeFile(
      join(raiz, 'fluxo.json'),
      JSON.stringify(
        {
          livro,
          ata: ata.id,
          ataVersao: ata.versaoId,
          abertura: abertura.versaoId,
          encerramento: encerramento.versaoId,
          evento: evento.id,
          ataPaginas: ata.paginas,
          registros: volume.registros.length,
          paginasCompilacao: (await PDFDocument.load(compilacao)).getPageCount(),
          correspondencias: 5,
          loteMs,
          repeticoesPorConcorrencia,
          leiturasHttp: latencias.length,
          p95HttpMs: latencias[Math.ceil(latencias.length * 0.95) - 1],
          maxHttpMs: Math.max(...latencias),
          ...picos,
        },
        null,
        2,
      ),
    );
  }, 180_000);
});
