import { habilitarAutorDeTeste } from './fixtures/autor-modelo';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PDFDocument } from 'pdf-lib';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { sha256 } from '../src/secretaria/expedicao-arquivos';
import { ExpedicaoWorkerService } from '../src/secretaria/expedicao-worker.service';
import { RascunhosService } from '../src/secretaria/rascunhos.service';
import type { VersaoInput } from '../src/secretaria/secretaria.dto';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;

integration('E08: resoluções, integridade e consulta de atuação', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: string;
  const igreja = randomUUID(),
    outraIgreja = randomUUID();
  const conselheiro = randomUUID();
  const lider = randomUUID(),
    coautora = randomUUID(),
    observador = randomUUID(),
    externo = randomUUID();
  const contexto = randomUUID();
  const cookies = new Map<string, string>();
  let modelo: string, vedado: string, reuniao: string;
  const data = '2026-01-20';
  const ambiente = {
    FEATURE_SECRETARIA: process.env.FEATURE_SECRETARIA,
    FEATURE_SECRETARIA_ASSINATURAS: process.env.FEATURE_SECRETARIA_ASSINATURAS,
    PRIVATE_STORAGE_ROOT: process.env.PRIVATE_STORAGE_ROOT,
  };

  const http = (metodo: 'post' | 'patch' | 'get', path: string, ator = 'gestor') =>
    request(app.getHttpServer())
      [metodo](`/secretaria/${path}`)
      .set('Cookie', cookies.get(ator)!)
      .set('Origin', 'http://localhost:3001')
      .set('X-Provisao-Request', '1');
  const comando = (revisao: number) => ({
    revisao,
    idempotencia: randomUUID(),
    autoridade: 'Mesa',
    evidencia: 'Ato documentado',
  });
  const assuntoAberto = 'Coautoria registrada';
  const assuntoRestrito = 'Assunto reservado E08';
  const resolucao = (ordem = 1): NonNullable<VersaoInput['resolucoes']>[number] => ({
    ordem,
    assunto: 'Proposta sem autoria',
    texto_proposta: null,
    texto_deliberado: 'Redação aprovada pela assembleia.',
    resultado: 'APROVADA',
    eficaz: true,
    data_efeito: null,
    votacao_secreta: false,
    apuracao: null,
    proponentes_pessoas_ids: [],
    dissidentes_pessoas_ids: [],
  });
  const versao = (resolucoes?: VersaoInput['resolucoes']): VersaoInput => ({
    modelo_versao_id: modelo,
    reuniao_id: reuniao,
    motivador_id: null,
    assunto: 'Ata de teste E08',
    data_documento: data,
    conteudo: {
      teor: 'Registro da reunião.',
      campos: {},
      anexos: [],
      arrolados: [lider, coautora, observador].map((id, i) => ({
        pessoa_id: id,
        papeis: i === 0 ? ['PRESIDENTE', 'SECRETARIO'] : ['PARTICIPANTE'],
        cargo_id: null,
        cargos_ids: [],
        assina: i === 0,
        obrigatorio: i === 0,
        responsavel: i === 0,
        fundamento: i === 0 ? 'Presidência registrada' : '',
      })),
    },
    resolucoes,
  });
  const criar = (v: VersaoInput, restrito = false) =>
    http('post', 'documentos').send({
      contexto_id: contexto,
      versao: v,
      restrito,
      idempotencia: randomUUID(),
    });
  async function aprovar(id: string, revisao = 1) {
    await http('post', `documentos/${id}/encaminhar`).send(comando(revisao)).expect(201);
    await http('post', `documentos/${id}/deliberar`)
      .send({
        ...comando(revisao + 1),
        data,
        reuniao_id: reuniao,
        resultado: 'APROVADA',
      })
      .expect(201);
    await http('post', `documentos/${id}/aprovar`)
      .send({ ...comando(revisao + 2), modalidade: 'FISICA' })
      .expect(201);
    return (await http('get', `documentos/${id}`).expect(200)).body;
  }

  async function expedirFisicamente(aprovado: Awaited<ReturnType<typeof aprovar>>) {
    const id = aprovado.id;
    const v = aprovado.versoes[0];
    const job = await prisma.trabalho_renderizacao.findFirstOrThrow({
      where: { versao_id: v.id, finalidade: 'MATRIZ_APROVADA' },
    });
    for (let i = 0; i < 45; i++) {
      if ((await prisma.trabalho_renderizacao.findUniqueOrThrow({ where: { id: job.id } })).estado === 'CONCLUIDO')
        break;
      if (!(await app.get(RascunhosService).executarUm())) break;
    }
    const base = { versao_id: v.id, revisao: aprovado.revisao };
    await http('post', `documentos/${id}/assinaturas/via`)
      .send({ ...base, idempotencia: randomUUID() })
      .expect(201);
    const via = (await http('get', `documentos/${id}/assinaturas/${v.id}/arquivos/via`).expect(200)).body as Buffer;
    const texto = execFileSync('pdftotext', ['-layout', '-', '-'], { input: via, encoding: 'utf8' });
    const scan = await PDFDocument.load(via);
    scan.getPages().at(-1)!.drawText('Conferencia sintetica', { x: 80, y: 70, size: 9 });
    await http('post', `documentos/${id}/assinaturas/fisica/conferir`)
      .field(
        'dados',
        JSON.stringify({
          ...base,
          idempotencia: randomUUID(),
          via_sha256: sha256(via),
          evidencia: 'Conferência local',
          assinaturas: v.arrolados.filter(a => a.assina && a.obrigatorio).map(a => ({ arrolado_id: a.id, data, evidencia: 'Firma conferida' })),
        }),
      )
      .attach('file', Buffer.from(await scan.save()), 'scan.pdf')
      .expect(201);
    for (let i = 0; i < 45; i++) {
      if ((await prisma.documento.findUniqueOrThrow({ where: { id } })).estado === 'EXPEDIDO') break;
      if (!(await app.get(ExpedicaoWorkerService).executarUm())) break;
    }
    const expedido = (await http('get', `documentos/${id}`).expect(200)).body;
    expect(expedido.estado).toBe('EXPEDIDO');
    return { expedido, texto };
  }

  beforeAll(async () => {
    if (
      process.env.DATABASE_URL !==
      'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public'
    ) {
      throw new Error('Exige o PostgreSQL descartável E00.');
    }
    storage = await mkdtemp(join(tmpdir(), 'provisao-e08-'));
    Object.assign(process.env, {
      FEATURE_SECRETARIA: 'true',
      FEATURE_SECRETARIA_ASSINATURAS: 'true',
      PRIVATE_STORAGE_ROOT: storage,
    });
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.igreja.createMany({ data: [igreja, outraIgreja].map((id) => ({ id, nome: 'Igreja de teste E08' })) });
    await prisma.pessoas.createMany({
      data: [
        { id: lider, nome_completo: 'Maria Histórica', igreja_id: igreja },
        { id: coautora, nome_completo: 'Ana Histórica', igreja_id: igreja },
        { id: observador, nome_completo: 'Eva Observadora', igreja_id: igreja },
        { id: externo, nome_completo: 'Pessoa da outra igreja', igreja_id: outraIgreja },
      ].map((p) => ({ ...p, sexo: 'FEMININO', data_nascimento: new Date('1991-01-01') })),
    });
    await prisma.pessoas.create({ data: { id: conselheiro, igreja_id: igreja, nome_completo: 'Presbítero do ensaio de sigilo', sexo: 'MASCULINO', data_nascimento: new Date('1980-01-01') } });
    const inicio = new Date('2020-01-01');
    const oficial = await prisma.oficial.create({ data: { igreja_id: igreja, pessoa_id: conselheiro, tipo: 'PRESBITERO_DOCENTE' } });
    await prisma.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, tipo: 'ORDENACAO', data_efeito: inicio,
      ordem: 1, autoridade: 'Presbitério', evidencia: 'Registro de ordenação' } });
    await prisma.vinculo_pastoral.create({ data: { igreja_id: igreja, oficial_id: oficial.id, data_inicio: inicio, exercicio_institucional: true,
      modalidade: 'Pastor', concilio: 'Presbitério', ato: 'Posse', evidencia: 'Registro de posse' } });
    for (const [chave, perfil, igreja_id, pessoa_id] of [
      ['gestor', 'GESTOR', igreja, lider],
      ['conselheiro', 'GESTOR', igreja, conselheiro],
      ['auditor', 'AUDITOR', igreja, null],
      ['outra', 'AUDITOR', outraIgreja, null],
    ] as const) {
      const u = await prisma.usuarios.create({
        data: {
          igreja_id,
          pessoa_id,
          perfil,
          nome_usuario: chave,
          email_login: `${randomUUID()}@example.invalid`,
          senha_hash: 'teste',
        },
      });
      cookies.set(chave, 'provisao_session=' + (await app.get(SessionService).create(u.id, igreja_id, u.auth_version)));
    }
    const usuario = await prisma.usuarios.findFirstOrThrow({ where: { igreja_id: igreja, pessoa_id: lider } });
    await prisma.contexto_secretaria.create({
      data: { id: contexto, igreja_id: igreja, tipo: 'ASSEMBLEIA_GERAL', nome: 'Assembleia Histórica', sigla: 'AG' },
    });
    await prisma.competencia_secretaria.create({
      data: {
        contexto_id: contexto,
        igreja_id: igreja,
        usuario_id: usuario.id,
        pessoa_id: lider,
        registrado_por_id: usuario.id,
        inicio: new Date('2020-01-01'),
        pode_aprovar: true,
        pode_deliberar: true,
        pode_consultar_restritos: true,
        autoridade: 'Assembleia',
        evidencia: 'Competência sintética',
      },
    });
    const criar = [await habilitarAutorDeTeste(prisma, igreja, usuario.id)];
    for (const politica of ['OBRIGATORIO', 'NAO_PERMITE']) {
      const m = await http('post', 'modelos')
        .send({
          publicar: true,
          tipo: 'ATA',
          finalidade: 'ATA_AGO',
          contexto_id: contexto,
          nome: 'Ata de teste ' + politica,
          idempotencia: randomUUID(),
          configuracao: {
              atuacao: { criar, preparar: [], assinar: [] },
            perfil: 'ATA',
            contexto: 'ASSEMBLEIA_GERAL',
            motivador: 'NAO_PERMITE',
            resolucoes: politica,
            campos_obrigatorios: [],
            papeis_obrigatorios: [],
            cargos_obrigatorios: [],
          },
        })
        .expect(201);
      if (politica === 'OBRIGATORIO') modelo = m.body.versao_id;
      else vedado = m.body.versao_id;
    }
    reuniao = (
      await http('post', 'reunioes')
        .send({
          contexto_id: contexto,
          idempotencia: randomUUID(),
          dados: {
            restrito: false,
            modalidade: 'AGO',
            data,
            local: 'Templo',
            itens_pauta: [{ descricao: 'Primeiro assunto', proponente_id: null }, { descricao: 'Segundo assunto', proponente_id: null }],
            competencia: 'Assembleia',
            universo_informado: 3,
            quorum_minimo: 2,
            quorum_conferido: true,
            fundamento_quorum: 'Presença conferida',
            resultado: '',
            participantes: [lider, coautora, observador].map((pessoa_id, i) => ({
              pessoa_id,
              presente: true,
              pode_propor: i < 2,
              papeis: i === 0 ? ['PRESIDENTE', 'SECRETARIO'] : ['PARTICIPANTE'],
            })),
          },
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(ambiente)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (app) await app.close();
    if (storage) await rm(storage, { recursive: true, force: true });
  });

  it('aplica a política do modelo e veda vínculos cruzados, duplicação, dissidência secreta e eficácia indevida', async () => {
    const semResolucoes = (await criar(versao()).expect(201)).body.id;
    await http('post', `documentos/${semResolucoes}/encaminhar`).send(comando(1)).expect(400);
    await criar({ ...versao([resolucao()]), modelo_versao_id: vedado }).expect(400);
    await criar(versao([{ ...resolucao(), proponentes_pessoas_ids: [externo] }])).expect(400);
    await criar(versao([{ ...resolucao(), proponentes_pessoas_ids: [observador] }])).expect(400);
    await criar(versao([{ ...resolucao(), proponentes_pessoas_ids: [lider, lider] }])).expect(400);
    await criar(versao([{ ...resolucao(), dissidentes_pessoas_ids: [lider], votacao_secreta: true }])).expect(400);
    await criar(versao([{ ...resolucao(), resultado: 'REJEITADA', eficaz: true }])).expect(400);
    await criar(versao([resolucao(), resolucao()])).expect(400);
    const d1 = (await criar(versao([resolucao()])).expect(201)).body.id;
    const d2 = (await criar(versao([resolucao()])).expect(201)).body.id;
    const primeiro = (await http('get', `documentos/${d1}`).expect(200)).body.versoes[0];
    const segundo = (await http('get', `documentos/${d2}`).expect(200)).body.versoes[0];
    await expect(
      prisma.resolucao_proponente.create({
        data: {
          resolucao_id: primeiro.resolucoes[0].id,
          arrolado_id: segundo.arrolados[0].id,
          igreja_id: igreja,
          contexto_id: contexto,
          versao_id: primeiro.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('congela coautoria e dissidência, assina e expede a resolução sem proponente na mesma ata', async () => {
    const semAutoria = resolucao();
    const alterada = {
      ...resolucao(2),
      assunto: assuntoAberto,
      resultado: 'APROVADA_COM_ALTERACOES' as const,
      texto_proposta: 'Redação original',
      data_efeito: '2026-01-31',
      proponentes_pessoas_ids: [lider, coautora],
      dissidentes_pessoas_ids: [lider],
      apuracao: { favoraveis: 2, contrarios: 1, abstencoes: 0, impedimentos: 0, quorum: 3 },
    };
    const rejeitada = {
      ...resolucao(3),
      assunto: '=Assunto rejeitado',
      texto_proposta: 'Texto submetido à votação',
      texto_deliberado: null,
      resultado: 'REJEITADA' as const,
      eficaz: false,
      votacao_secreta: true,
      apuracao: { favoraveis: 0, contrarios: 3 },
    };
    const id = (await criar(versao([semAutoria, alterada, rejeitada])).expect(201)).body.id;
    // Consumidor anterior omite a lista ao editar um campo do documento.
    await http('patch', `documentos/${id}`)
      .send({ revisao: 1, idempotencia: randomUUID(), versao: versao() })
      .expect(200);
    const aprovado = await aprovar(id, 2);
    const v = aprovado.versoes[0];
    expect(v.resolucoes.map((r) => r.ordem)).toEqual([1, 2, 3]);
    expect(v.resolucoes[0].proponentes).toEqual([]);
    expect(v.resolucoes[1].proponentes.map((p) => p.arrolado.pessoa_id)).toEqual(
      expect.arrayContaining([lider, coautora]),
    );
    expect(v.resolucoes[1].dissidentes[0].arrolado.pessoa_id).toBe(lider);
    await expect(prisma.resolucao.delete({ where: { id: v.resolucoes[0].id } })).rejects.toThrow();
    await expect(
      prisma.resolucao_proponente.deleteMany({ where: { resolucao_id: v.resolucoes[1].id } }),
    ).rejects.toThrow();
    await http('patch', `documentos/${id}`)
      .send({ revisao: aprovado.revisao, idempotencia: randomUUID(), versao: versao([]) })
      .expect(400);

    const { expedido, texto } = await expedirFisicamente(aprovado);
    expect(texto).toContain('Sem proponente informado');
    expect(texto).toContain('Coautoria registrada');
    expect(texto).toContain('Redação original');
    expect(
      (await http('get', `atuacao?pessoa=${lider}&assunto=${encodeURIComponent(assuntoAberto)}`, 'auditor').expect(200))
        .body.totais,
    ).toEqual({ total: 1, autoria: 1, coautoria: 1, dissidencia: 1, presenca: 1, assinatura: 1 });
    expect(
      (
        await http('get', `atuacao?pessoa=${coautora}&assunto=${encodeURIComponent(assuntoAberto)}`, 'auditor').expect(
          200,
        )
      ).body.totais,
    ).toMatchObject({ total: 1, autoria: 1, dissidencia: 0, presenca: 1, assinatura: 0 });
    expect(
      (
        await http(
          'get',
          `atuacao?pessoa=${observador}&assunto=${encodeURIComponent(semAutoria.assunto)}`,
          'auditor',
        ).expect(200)
      ).body.totais,
    ).toMatchObject({ total: 1, autoria: 0, presenca: 1, assinatura: 0 });
    expect(
      (
        await http('get', `atuacao?contexto=${contexto}&de=${data}&ate=${data}&resultado=REJEITADA`, 'auditor').expect(
          200,
        )
      ).body.itens,
    ).toEqual([expect.objectContaining({ resultado: 'REJEITADA', eficaz: false })]);

    await http('post', `documentos/${id}/retificar`)
      .send({ ...comando(expedido.revisao), versao: versao() })
      .expect(201)
      .then(async (r) => {
        expect(r.body.id).not.toBe(id);
        const nova = (await http('get', `documentos/${r.body.id}`).expect(200)).body.versoes[0];
        expect(nova).toMatchObject({ retifica_versao_id: v.id, congelado_em: null });
        expect(nova.resolucoes).toHaveLength(3);
      });
  }, 120_000);

  it('preserva o retrato histórico e aplica o mesmo recorte de sigilo a busca, indicadores e CSV', async () => {
    const entrada = versao([{ ...resolucao(), assunto: assuntoRestrito }]);
    await criar(entrada, true).expect(403);
    const restrito = (await criar(entrada).expect(201)).body.id;
    const aprovada = await aprovar(restrito);
    await http('post', `documentos/${restrito}/sigilo`, 'conselheiro')
      .send({ revisao: aprovada.revisao, restrito: true, idempotencia: randomUUID() }).expect(201);
    await prisma.pessoas.update({ where: { id: lider }, data: { nome_completo: 'Nome atual diferente' } });
    await prisma.contexto_secretaria.update({ where: { id: contexto }, data: { nome: 'Assembleia atual' } });
    const resposta = (await http('get', 'atuacao', 'auditor').expect(200)).body;
    expect(resposta.totais).toEqual({ total: 3, autoria: 1, coautoria: 1, dissidencia: 1, presenca: 3, assinatura: 3 });
    expect(resposta.itens.find((r) => r.assunto === assuntoAberto)).toMatchObject({
      contexto: 'Assembleia Histórica',
      proponentes: 'Ana Histórica; Maria Histórica',
    });
    const semAcesso = await http('get', `atuacao?assunto=${encodeURIComponent(assuntoRestrito)}`, 'auditor').expect(
      200,
    );
    expect(semAcesso.body.totais).toEqual({
      total: 0,
      autoria: 0,
      coautoria: 0,
      dissidencia: 0,
      presenca: 0,
      assinatura: 0,
    });
    expect(semAcesso.body.itens).toEqual([]);
    expect(
      (await http('get', 'atuacao?tipo=registros&resultado=REJEITADA', 'auditor').expect(200)).body.totais.total,
    ).toBe(1);
    expect((await http('get', 'atuacao?tipo=registros', 'outra').expect(200)).body.totais.total).toBe(0);
    await http('get', `documentos/${restrito}`, 'auditor').expect(404);
    const exportar = (ator: string) => http('post', 'atuacao/exportar', ator).send({ tipo: 'resolucoes' }).expect(200);
    const aberto = await exportar('auditor');
    expect((await exportar('gestor')).text).not.toContain(assuntoRestrito);
    const autorizado = await exportar('conselheiro');
    expect(aberto.headers['cache-control']).toBe('private, no-store');
    expect(aberto.text).toContain('Sem proponente informado');
    expect(aberto.text).toContain("'=Assunto rejeitado");
    expect(aberto.text).not.toContain(assuntoRestrito);
    expect(autorizado.text).toContain(assuntoRestrito);
  }, 30000);

  it('expede uma ata em que nenhum proponente foi informado', async () => {
    const id = (await criar(versao([resolucao()])).expect(201)).body.id;
    const aprovado = await aprovar(id);
    expect(aprovado.versoes[0].resolucoes[0].proponentes).toEqual([]);
    const { texto } = await expedirFisicamente(aprovado);
    expect(texto).toContain('Sem proponente informado');
  }, 120_000);
  it('confere a identidade da mesa e reúne os papéis de quem presidiu e secretariou', async () => {
    const original = await prisma.modelo_documento_versao.findUniqueOrThrow({ where: { id: modelo } });
    const m = await http('post', 'modelos').send({ contexto_id: contexto, nome: 'Ata assinada pela mesa', tipo: 'ATA',
      finalidade: 'ATA_AGO', publicar: true, idempotencia: randomUUID(),
      configuracao: { ...(original.configuracao as object), assinaturas_reuniao: 'MESA' } }).expect(201);
    const entrada = versao([resolucao()]);
    entrada.modelo_versao_id = m.body.versao_id;
    entrada.conteudo.arrolados = entrada.conteudo.arrolados.map(p => ({
      ...p, obrigatorio: p.pessoa_id === coautora, assina: p.pessoa_id === coautora,
      papeis: ['PRESIDENTE','SECRETARIO'], fundamento: 'Indicação para conferência',
    }));
    const { id } = (await criar(entrada).expect(201)).body;
    const detalhe = (await http('get', 'documentos/' + id).expect(200)).body;
    expect(detalhe.sugestoes_arrolados.filter(p => p.obrigatorio)).toEqual([
      expect.objectContaining({ pessoa_id: lider, papeis: ['PRESIDENTE','SECRETARIO'] }),
    ]);
    expect(detalhe.tramitacao.pendencias).toContainEqual({ destino: 'arrolados', mensagem: expect.stringContaining('signatário obrigatório com o papel de PRESIDENTE e SECRETARIO') });
    await http('post', 'documentos/' + id + '/encaminhar').send(comando(1)).expect(400);
  });

  it('recepciona várias decisões por item, exige os presentes e posiciona as decisões na matriz paginada', async () => {
    const original = await prisma.modelo_documento_versao.findUniqueOrThrow({ where: { id: modelo } });
    const campo = await prisma.campo_secretaria.findFirstOrThrow({ where: { igreja_id: igreja, origem: 'deliberacoes_reuniao' } });
    const espaco = { superior: 0, inferior: 0 };
    const paragrafo = (texto: string) => ({ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'texto', texto }] });
    const composicao = { versao_formato: 2, pagina: { papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
      margens_cm: { superior: 2, inferior: 2, esquerda: 2, direita: 2 }, altura_minima_cm: { cabecalho: 0, rodape: 0 },
      espacamento_cm: { cabecalho: espaco, corpo: espaco, rodape: espaco } }, cabecalho: [], rodape: [], notas: {},
      corpo: [paragrafo('Abertura da pauta'), { tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [
        { tipo: 'campo', campo_id: campo.id, apresentacao: 'em_linha' }] }, paragrafo('Encerramento da pauta')] };
    const m = await http('post', 'modelos').send({ contexto_id: contexto, nome: 'Ata com deliberações em linha', tipo: 'ATA',
      finalidade: 'ATA_AGO', publicar: true, idempotencia: randomUUID(),
      configuracao: { ...(original.configuracao as object), assinaturas_reuniao: 'PRESENTES', composicao_padrao: composicao } }).expect(201);
    const itens = await prisma.item_pauta_reuniao.findMany({ where: { reuniao_id: reuniao }, orderBy: { ordem: 'asc' } });
    const decisoes = ['Primeira escolha', 'Segunda escolha', 'Terceira escolha'].map((assunto,i) =>
      ({ ...resolucao(i+1), assunto, item_pauta_id: itens[i === 2 ? 1 : 0].id }));
    decisoes[1].texto_deliberado = 'Explicação da decisão tomada. '.repeat(180);
    const entrada = versao([...decisoes].reverse());
    entrada.modelo_versao_id = m.body.versao_id;
    entrada.conteudo.teor = '';
    await criar({ ...entrada, resolucoes: [{ ...decisoes[0], item_pauta_id: randomUUID() }] }).expect(400);
    const { id } = (await criar(entrada).expect(201)).body;
    const detalhe = (await http('get', 'documentos/' + id).expect(200)).body;
    await expect(prisma.documento_versao.update({ where: { id: detalhe.versoes[0].id }, data: { reuniao_id: null } })).rejects.toMatchObject({ code: 'P2003' });
    expect(detalhe.sugestoes_arrolados.map(p => p.pessoa_id).sort()).toEqual([lider, coautora, observador].sort());
    expect(detalhe.sugestoes_arrolados.every(p => p.assina && p.obrigatorio)).toBe(true);
    expect(detalhe.versoes[0].resolucoes.map(r => r.item_pauta_id)).toEqual([itens[0].id, itens[0].id, itens[1].id]);
    await http('post', 'documentos/' + id + '/encaminhar').send(comando(1)).expect(400);
    entrada.conteudo = { ...detalhe.versoes[0].conteudo, arrolados: detalhe.sugestoes_arrolados.map(p => ({ ...p, responsavel: p.pessoa_id === lider })) };
    await http('patch', 'documentos/' + id).send({ idempotencia: randomUUID(), revisao: 1, versao: entrada }).expect(200);
    const aprovado = await aprovar(id, 2);
    const v = aprovado.versoes[0];
    expect(v.conteudo.valores[campo.id].valor.map((s: string) => s.split(' — ')[0])).toEqual(decisoes.map(r => r.assunto));
    const { texto } = await expedirFisicamente(aprovado);
    const limpo = texto.replace(/\s+/g, ' ');
    expect(limpo.indexOf('Abertura da pauta')).toBeLessThan(limpo.indexOf('Primeira escolha'));
    expect(limpo.indexOf('Terceira escolha')).toBeLessThan(limpo.indexOf('Encerramento da pauta'));
    for (const frase of ['Abertura da pauta', ...decisoes.map(r => r.assunto), 'Encerramento da pauta']) expect(limpo.split(frase)).toHaveLength(2);
    expect(texto.indexOf('Primeira escolha')).toBeLessThan(texto.indexOf('\f'));
    expect(texto.indexOf('Encerramento da pauta')).toBeGreaterThan(texto.indexOf('\f'));
  }, 120_000);

});
