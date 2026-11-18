import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { EmailService } from '../src/email/email.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { sha256 } from '../src/secretaria/expedicao-arquivos';
import { ExpedicaoWorkerService } from '../src/secretaria/expedicao-worker.service';
import { RascunhosService } from '../src/secretaria/rascunhos.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;

integration('E07: assinatura e expedição por versão', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let contexto: string;
  let modelo: string;
  let storage: string;
  const igreja = randomUUID(),
    outraIgreja = randomUUID();
  const gestor = randomUUID(),
    vinculado = randomUUID(),
    convidado = randomUUID(),
    opcional = randomUUID();
  const secretario = randomUUID(),
    admin = randomUUID(),
    outraConta = randomUUID();
  const emails = new Map([gestor, vinculado, convidado, opcional].map((id) => [id, `${id}@example.invalid`]));
  const cookies = new Map<string, string>();
  const data = '2026-01-12';
  const origem = 'http://localhost:3001';
  const ambiente = {
    FEATURE_SECRETARIA: process.env.FEATURE_SECRETARIA,
    FEATURE_SECRETARIA_ASSINATURAS: process.env.FEATURE_SECRETARIA_ASSINATURAS,
    PRIVATE_STORAGE_ROOT: process.env.PRIVATE_STORAGE_ROOT,
  };

  const post = (path: string, ator?: string) => {
    const req = request(app.getHttpServer()).post(path).set('Origin', origem).set('X-Provisao-Request', '1');
    return ator ? req.set('Cookie', cookies.get(ator)!) : req;
  };
  const get = (path: string, ator?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return ator ? req.set('Cookie', cookies.get(ator)!) : req;
  };
  const cmd = (revisao: number) => ({
    revisao,
    idempotencia: randomUUID(),
    autoridade: 'Mesa',
    evidencia: 'Ato institucional',
  });
  const url = (id: string) => `/secretaria/documentos/${id}`;
  const portal = '/assinaturas/convite';
  const pdfTexto = (pdf: Buffer) => execFileSync('pdftotext', ['-layout', '-', '-'], { input: pdf, encoding: 'utf8' });
  const status = async (id: string) => (await get(url(id), gestor).expect(200)).body.estado;
  const arquivo = (id: string, v: string, tipo: string, ator = gestor) =>
    get(`${url(id)}/assinaturas/${v}/arquivos/${tipo}`, ator);
  const operacao = (id: string, acao: string, ator = gestor) => post(`${url(id)}/assinaturas/${acao}`, ator);

  beforeAll(async () => {
    if (
      process.env.DATABASE_URL !==
        'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public' ||
      process.env.SMTP_HOST !== '127.0.0.1' ||
      process.env.SMTP_PORT !== '51025'
    ) {
      throw new Error('Requer o banco e o SMTP descartáveis do ambiente E00.');
    }
    storage = await mkdtemp(join(tmpdir(), 'provisao-e07-'));
    Object.assign(process.env, {
      FEATURE_SECRETARIA: 'true',
      FEATURE_SECRETARIA_ASSINATURAS: 'true',
      PRIVATE_STORAGE_ROOT: storage,
    });
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.igreja.createMany({
      data: [
        { id: igreja, nome: 'Igreja de teste E07' },
        { id: outraIgreja, nome: 'Outra igreja' },
      ],
    });
    await prisma.configuracao_fuso_igreja.create({ data: { igreja_id: igreja, fuso_iana: 'America/Sao_Paulo' } });
    for (const [i, id] of [gestor, vinculado, convidado, opcional].entries()) {
      await prisma.pessoas.create({
        data: {
          id,
          igreja_id: igreja,
          nome_completo: ['Gestora', 'Signatário vinculado', 'Signatária convidada', 'Signatário opcional'][i],
          email: emails.get(id)!,
          sexo: 'FEMININO',
          data_nascimento: new Date('1985-01-01'),
        },
      });
    }
    for (const [id, papel, tenant, pessoa] of [
      [gestor, 'GESTOR', igreja, gestor],
      [vinculado, 'OPERADOR', igreja, vinculado],
      [secretario, 'SECRETARIO', igreja, null],
      [admin, 'ADMINISTRADOR', igreja, null],
      [outraConta, 'ADMINISTRADOR', outraIgreja, null],
    ] as const) {
      await prisma.usuarios.create({
        data: {
          id,
          igreja_id: tenant,
          nome_usuario: papel,
          email_login: id === outraConta ? emails.get(vinculado)! : `${id}@example.invalid`,
          senha_hash: 'teste',
          perfil: papel,
          pessoa_id: pessoa,
        },
      });
      cookies.set(id, 'provisao_session=' + (await app.get(SessionService).create(id, tenant, 0)));
    }
    contexto = (
      await post('/secretaria/contextos', admin)
        .send({
          tipo: 'ASSEMBLEIA_GERAL',
          nome: 'Assembleia',
          sigla: 'AG',
          idempotencia: randomUUID(),
        })
        .expect(201)
    ).body.id;
    await post('/secretaria/competencias', admin)
      .send({
        contexto_id: contexto,
        usuario_id: gestor,
        inicio: '2020-01-01',
        pode_aprovar: true,
        pode_deliberar: true,
        pode_consultar_restritos: true,
        autoridade: 'Assembleia',
        evidencia: 'Competência sintética',
        idempotencia: randomUUID(),
      })
      .expect(201);
    modelo = (
      await post('/secretaria/modelos', secretario)
        .send({
          contexto_id: contexto,
          tipo: 'OUTRO',
          finalidade: 'CARTA',
          nome: 'Carta de teste',
          idempotencia: randomUUID(),
          configuracao: {
            contexto: 'ASSEMBLEIA_GERAL',
            perfil: 'CARTA',
            motivador: 'NAO_PERMITE',
            resolucoes: 'NAO_PERMITE',
            campos_obrigatorios: [],
            papeis_obrigatorios: [],
            cargos_obrigatorios: [],
          },
        })
        .expect(201)
    ).body.versao_id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (storage) await rm(storage, { recursive: true, force: true });
    for (const [chave, valor] of Object.entries(ambiente)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  async function criar(modalidade: 'ELETRONICA' | 'FISICA', pessoas: string[], restrito = false) {
    const versao = {
      modelo_versao_id: modelo,
      assunto: 'Conteúdo sintético E07',
      data_documento: data,
      conteudo: {
        teor: 'Teor da versão aprovada.',
        campos: {},
        anexos: [],
        arrolados: pessoas.map((pessoa_id, i) => ({
          pessoa_id,
          papeis: ['PRESIDENTE'],
          assina: true,
          obrigatorio: pessoa_id !== opcional,
          responsavel: i === 0,
          fundamento: 'Responsabilidade documentada',
        })),
      },
    };
    const preparador = restrito ? gestor : secretario;
    const id = (
      await post('/secretaria/documentos', preparador)
        .send({ contexto_id: contexto, restrito, idempotencia: randomUUID(), versao })
        .expect(201)
    ).body.id;
    const rascunho = (await get(url(id), gestor).expect(200)).body.versoes[0].id;
    await operacao(id, 'convidar')
      .send({
        versao_id: rascunho,
        revisao: 1,
        arrolado_id: randomUUID(),
        idempotencia: randomUUID(),
        evidencia: 'Individual',
        canal_individual: true,
      })
      .expect(404);
    if (pessoas.every((p) => p === opcional)) {
      await post(`${url(id)}/encaminhar`, preparador)
        .send(cmd(1))
        .expect(400);
      return null;
    }
    await post(`${url(id)}/encaminhar`, preparador)
      .send(cmd(1))
      .expect(201);
    await post(`${url(id)}/aprovar`, gestor)
      .send(cmd(2))
      .expect(400);
    await post(`${url(id)}/aprovar`, gestor)
      .send({ ...cmd(2), modalidade })
      .expect(201);
    const detalhe = (await get(url(id), gestor).expect(200)).body;
    const atual = detalhe.versoes[0];
    const job = await prisma.trabalho_renderizacao.findFirstOrThrow({
      where: { versao_id: atual.id, finalidade: 'MATRIZ_APROVADA' },
    });
    // Trabalhos concluídos em outros ensaios são ignorados, filas pendentes conservam a ordenação.
    for (let i = 0; i < 80; i++) {
      if ((await prisma.trabalho_renderizacao.findUniqueOrThrow({ where: { id: job.id } })).estado === 'CONCLUIDO')
        break;
      await app.get(RascunhosService).executarUm();
    }
    expect((await prisma.trabalho_renderizacao.findUniqueOrThrow({ where: { id: job.id } })).estado).toBe('CONCLUIDO');
    return {
      id: id as string,
      versao,
      atual,
      base: { versao_id: atual.id as string, revisao: detalhe.revisao as number },
    };
  }

  function convite(id: string, base: { versao_id: string; revisao: number }, arrolado_id: string) {
    const dados = {
      ...base,
      arrolado_id,
      evidencia: 'Caixa individual verificada',
      canal_individual: true,
      idempotencia: randomUUID(),
    };
    return { dados, enviar: () => operacao(id, 'convidar').send(dados) };
  }

  async function entregar(conviteId: string, email: string) {
    const where = { convite_assinatura_id: conviteId };
    await prisma.outbox_email.update({ where, data: { proxima_tentativa: new Date(0), created_at: new Date(0) } });
    for (let i = 0; i < 20; i++) {
      const tarefa = await prisma.outbox_email.findUniqueOrThrow({ where });
      if (tarefa.estado === 'ENVIADO') break;
      await app.get(OutboxService).runOnce();
    }
    expect(await prisma.outbox_email.findUniqueOrThrow({ where })).toMatchObject({ estado: 'ENVIADO', payload: null });
    const caixa = 'http://127.0.0.1:58025/api/v1';
    const resultado = (await (await fetch(`${caixa}/search?query=${encodeURIComponent('to:' + email)}`)).json()) as {
      messages: { ID: string }[];
    };
    const mensagem = (await (await fetch(`${caixa}/message/${resultado.messages[0].ID}`)).json()) as { Text: string };
    const token = mensagem.Text.match(/\/assinaturas\/convite#([a-f0-9]{64})/)?.[1];
    expect(token).toBeDefined();
    return token!;
  }

  it('autentica o canal e a conta vinculada, serializa assinaturas e retoma a expedição', async () => {
    await criar('ELETRONICA', [opcional]);
    const d = (await criar('ELETRONICA', [vinculado, convidado], true))!;
    await expect(prisma.documento.update({ where: { id: d.id }, data: { estado: 'EXPEDIDO' } })).rejects.toThrow();
    await get(`${url(d.id)}/assinaturas`, outraConta).expect(404);
    const vinc = d.atual.arrolados.find((a) => a.pessoa_id === vinculado);
    const guest = d.atual.arrolados.find((a) => a.pessoa_id === convidado);
    const enviar = convite(d.id, d.base, vinc.id);
    await operacao(d.id, 'convidar', admin).send(enviar.dados).expect(404);
    const [primeiro, repetido] = await Promise.all([enviar.enviar().expect(201), enviar.enviar().expect(201)]);
    const c1 = primeiro.body.convite_id;
    expect(repetido.body.convite_id).toBe(c1);
    const c2 = (await convite(d.id, d.base, guest.id).enviar().expect(201)).body.convite_id;

    const smtp = jest
      .spyOn(app.get(EmailService), 'sendSignatureInvitation')
      .mockRejectedValueOnce(new Error('Falha SMTP simulada'));
    await prisma.outbox_email.update({ where: { convite_assinatura_id: c1 }, data: { created_at: new Date(0) } });
    expect(await app.get(OutboxService).runOnce()).toBe(true);
    expect(await prisma.outbox_email.findUnique({ where: { convite_assinatura_id: c1 } })).toMatchObject({
      estado: 'PENDENTE',
      tentativas: 1,
    });
    smtp.mockRestore();

    const t1 = await entregar(c1, emails.get(vinculado)!);
    const t2 = await entregar(c2, emails.get(convidado)!);
    expect(await prisma.convite_assinatura.findUnique({ where: { id: c1 } })).toMatchObject({
      hash: sha256(t1),
      consumido_em: null,
    });
    await get(`${portal}/decisao?token=${t1}`).expect(404);
    await post(`${portal}/consulta`).send({ token: t1 }).expect(401);
    await post(`${portal}/consulta`, outraConta).send({ token: t1 }).expect(404);
    await post(`${portal}/consulta`)
      .send({ token: randomBytes(32).toString('hex') })
      .expect(404);
    await request(app.getHttpServer()).post(`${portal}/consulta`).send({ token: t2 }).expect(403);

    const expirado = randomBytes(32).toString('hex');
    await prisma.convite_assinatura.create({
      data: {
        igreja_id: igreja,
        contexto_id: contexto,
        versao_id: d.base.versao_id,
        arrolado_id: guest.id,
        email: emails.get(convidado)!,
        hash: sha256(expirado),
        expira_em: new Date(0),
      },
    });
    await post(`${portal}/consulta`).send({ token: expirado }).expect(404);

    const leitura1 = (await post(`${portal}/consulta`, vinculado).send({ token: t1 }).expect(201)).body;
    const leitura2 = (await post(`${portal}/consulta`).send({ token: t2 }).expect(201)).body;
    const escopo = (token: string) => ({
      token,
      versao_id: leitura1.versao_id,
      manifesto_sha256: leitura1.manifesto_sha256,
    });
    expect(leitura2.manifesto_sha256).toBe(leitura1.manifesto_sha256);
    const decisao = { decisao: 'ASSINAR', consentimento: true };
    await post(`${portal}/decisao`)
      .send({ ...escopo(t2), ...decisao })
      .expect(409);
    await post(`${portal}/decisao`)
      .send({ ...escopo(t2), ...decisao, versao_id: randomUUID() })
      .expect(404);
    await post(`${portal}/arquivo`, vinculado).send(escopo(t1)).expect(201);
    await post(`${portal}/arquivo`).send(escopo(t2)).expect(201);
    await Promise.all([
      post(`${portal}/decisao`, vinculado)
        .send({ ...escopo(t1), ...decisao })
        .expect(201),
      post(`${portal}/decisao`)
        .send({ ...escopo(t2), ...decisao })
        .expect(201),
    ]);
    await post(`${portal}/decisao`)
      .send({ ...escopo(t2), ...decisao })
      .expect(404);
    expect(await status(d.id)).toBe('APROVADO');

    const where = { versao_id: d.base.versao_id };
    const expediente = await prisma.expedicao_documento.findUniqueOrThrow({ where });
    const matrixPath = join(storage, expediente.matriz_id!);
    const bons = await readFile(matrixPath);
    await writeFile(matrixPath, Buffer.alloc(bons.length));
    await prisma.expedicao_documento.update({
      where,
      data: {
        estado: 'PROCESSANDO',
        reserva_id: randomUUID(),
        reserva_ate: new Date(Date.now() - 1000),
        tentativas: 1,
      },
    });
    expect(await app.get(ExpedicaoWorkerService).executarUm()).toBe(true);
    expect(await status(d.id)).toBe('APROVADO');
    await arquivo(d.id, d.base.versao_id, 'final').expect(404);
    await writeFile(matrixPath, bons);
    await prisma.expedicao_documento.update({ where, data: { executar_apos: new Date(0) } });
    await Promise.all([app.get(ExpedicaoWorkerService).executarUm(), app.get(ExpedicaoWorkerService).executarUm()]);
    const final = await prisma.expedicao_documento.findUniqueOrThrow({ where });
    expect(final.estado).toBe('CONCLUIDA');
    expect(await status(d.id)).toBe('EXPEDIDO');
    expect(await prisma.assinatura_documento.count({ where })).toBe(2);
    expect(
      await prisma.logs_atividades.count({ where: { tabela_afetada: 'expedicao_documento', registro_id: final.id } }),
    ).toBe(1);
    const pdf = (await arquivo(d.id, d.base.versao_id, 'final').expect(200)).body as Buffer;
    const assinatura = await prisma.assinatura_documento.findFirstOrThrow({
      where: { ...where, arrolado_id: vinc.id },
    });
    const horaLocal = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: 'America/Sao_Paulo',
    }).format(assinatura.registrada_em);
    expect(pdfTexto(pdf)).toContain(horaLocal);
    expect(pdfTexto(pdf)).toContain('Signatária convidada');
    const verificar = () => get(`/assinaturas/verificacao/${final.codigo_verificacao}`);
    expect((await verificar().expect(200)).body).toEqual({
      estado: 'EXPEDIDO',
      modalidade: 'ELETRONICA',
      expedido_em: final.expedido_em!.toISOString(),
      sha256: sha256(pdf),
    });
    const manifesto = (await arquivo(d.id, d.base.versao_id, 'manifesto').expect(200)).body;
    expect(manifesto.manifesto.arquivo_final.sha256).toBe(sha256(pdf));
    expect(manifesto.manifesto.aceite.manifesto.matriz.sha256).toBe(sha256(bons));
    await arquivo(d.id, d.base.versao_id, 'final', outraConta).expect(404);
    await get('/arquivos-privados/' + final.arquivo_final_id, gestor).expect(404);
    const revisao = (await get(url(d.id), gestor).expect(200)).body.revisao;
    await operacao(d.id, 'via')
      .send({ ...d.base, revisao, idempotencia: randomUUID() })
      .expect(201);
    const via = (await arquivo(d.id, d.base.versao_id, 'via').expect(200)).body;
    expect(pdfTexto(via)).toContain('DERIVAÇÃO PARA COLETA FÍSICA');
    expect((await arquivo(d.id, d.base.versao_id, 'final').expect(200)).body).toEqual(pdf);
    await writeFile(join(storage, final.arquivo_final_id!), Buffer.alloc(pdf.length));
    await verificar().expect(503);
    await writeFile(join(storage, final.arquivo_final_id!), pdf);
    await post(`${url(d.id)}/anular`, gestor)
      .send(cmd(revisao))
      .expect(201);
    expect((await verificar().expect(200)).body.estado).toBe('ANULADO');
    process.env.FEATURE_SECRETARIA_ASSINATURAS = 'false';
    try {
      await arquivo(d.id, d.base.versao_id, 'final').expect(200);
      await verificar().expect(200);
      await post(`${portal}/consulta`, vinculado).send({ token: t1 }).expect(404);
    } finally {
      process.env.FEATURE_SECRETARIA_ASSINATURAS = 'true';
    }
  }, 120_000);

  it('registra recusa e invalida os convites da versão substituída ou da conta desativada', async () => {
    const d = (await criar('ELETRONICA', [vinculado, opcional]))!;
    const principal = d.atual.arrolados.find((a) => a.pessoa_id === vinculado);
    const opt = d.atual.arrolados.find((a) => a.pessoa_id === opcional);
    await prisma.pessoas.update({ where: { id: opcional }, data: { email: emails.get(vinculado)!.toUpperCase() } });
    await convite(d.id, d.base, principal.id).enviar().expect(409);
    await prisma.pessoas.update({ where: { id: opcional }, data: { email: emails.get(opcional) } });
    const c1 = (await convite(d.id, d.base, principal.id).enviar().expect(201)).body.convite_id;
    const c2 = (await convite(d.id, d.base, opt.id).enviar().expect(201)).body.convite_id;
    const a = await entregar(c1, emails.get(vinculado)!);
    const b = await entregar(c2, emails.get(opcional)!);
    await prisma.usuarios.update({ where: { id: vinculado }, data: { ativo: false, auth_version: { increment: 1 } } });
    await post(`${portal}/consulta`, vinculado).send({ token: a }).expect(404);
    const lido = (await post(`${portal}/consulta`).send({ token: b }).expect(201)).body;
    await post(`${portal}/decisao`)
      .send({
        token: b,
        decisao: 'RECUSAR',
        versao_id: lido.versao_id,
        manifesto_sha256: lido.manifesto_sha256,
        motivo: 'Impedimento informado',
      })
      .expect(201);
    await convite(d.id, d.base, opt.id).enviar().expect(409);
    expect(await prisma.assinatura_documento.count({ where: { versao_id: d.base.versao_id } })).toBe(0);
    await post(`${url(d.id)}/retificar`, gestor)
      .send({ ...cmd(d.base.revisao), versao: { ...d.versao, assunto: 'Versão substituta' } })
      .expect(201);
    expect(await prisma.convite_assinatura.findUnique({ where: { id: c1 } })).toMatchObject({
      revogado_em: expect.any(Date),
    });
    expect(await prisma.convite_assinatura.findUnique({ where: { id: c2 } })).toMatchObject({
      motivo_recusa: 'Impedimento informado',
    });
    expect(await status(d.id)).toBe('EM_EDICAO');
  }, 120_000);

  it('confere todos os obrigatórios antes de expedir o scan, preservado à parte', async () => {
    const d = (await criar('FISICA', [gestor, convidado]))!;
    await operacao(d.id, 'via')
      .send({ ...d.base, idempotencia: randomUUID() })
      .expect(201);
    const via = (await arquivo(d.id, d.base.versao_id, 'via').expect(200)).body as Buffer;
    expect(pdfTexto(via)).toContain('ASSINATURAS PENDENTES');
    expect(await status(d.id)).toBe('APROVADO');
    const original = await PDFDocument.load(via);
    original.getPages().at(-1)!.drawText('Marca de conferência sintética', { x: 80, y: 70, size: 9 });
    const scan = Buffer.from(await original.save());
    const dados = {
      ...d.base,
      idempotencia: randomUUID(),
      via_sha256: sha256(via),
      evidencia: 'Conferência do original físico',
    };
    const assinaturas = d.atual.arrolados.map((a) => ({
      arrolado_id: a.id,
      data,
      evidencia: 'Assinatura conferida na primeira face',
    }));
    const conferir = (lista: typeof assinaturas, bytes: Buffer) =>
      operacao(d.id, 'fisica/conferir')
        .field('dados', JSON.stringify({ ...dados, assinaturas: lista }))
        .attach('file', bytes, 'scan.pdf');
    await conferir(assinaturas.slice(0, 1), scan).expect(400);
    await conferir(assinaturas, via).expect(400);
    await conferir(assinaturas, scan).expect(201);
    await conferir(assinaturas, scan).expect(201);
    expect(await status(d.id)).toBe('APROVADO');
    await app.get(ExpedicaoWorkerService).executarUm();
    expect(await status(d.id)).toBe('EXPEDIDO');
    expect((await arquivo(d.id, d.base.versao_id, 'scan').expect(200)).body).toEqual(scan);
    const pdf = (await arquivo(d.id, d.base.versao_id, 'final').expect(200)).body;
    expect(pdfTexto(pdf)).toContain('Comprovante de conferência física');
    expect(pdfTexto(pdf)).toContain('Digitalização conferida por GESTOR');
    expect(
      await prisma.assinatura_documento.findMany({
        where: { versao_id: d.base.versao_id },
        select: { metodo: true, convite_id: true },
      }),
    ).toEqual([
      { metodo: 'FISICA', convite_id: null },
      { metodo: 'FISICA', convite_id: null },
    ]);
  }, 120_000);
});
