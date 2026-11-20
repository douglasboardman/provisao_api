import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { documento_tipo, orgao_tipo } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { hojeDaIgreja } from '../src/orgaos/relogio-igreja';
import { sha256 } from '../src/secretaria/expedicao-arquivos';
import { ExpedicaoWorkerService } from '../src/secretaria/expedicao-worker.service';
import { RascunhosService } from '../src/secretaria/rascunhos.service';

const integracao = process.env.E09_INTEGRATION === '1' ? describe : describe.skip;
const data = '2026-01-10';
const dia = new Date(data);
const externo = {
  concilio: 'Presbitério',
  identificacao: 'Ata 14',
  data,
  localizacao: 'Arquivo histórico',
  livro: '2',
  paginas: '30–31',
  conferida: true,
};

integracao('E09 – referências documentais', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: string;
  const igreja = randomUUID(),
    outraIgreja = randomUUID(),
    gestor = randomUUID(),
    pessoa = randomUUID(),
    membro = randomUUID();
  const cookies = new Map<string, string>();
  const concedente = randomUUID();
  let conselho: string,
    assembleia: string,
    unidade: string,
    junta: string,
    evento: string,
    disciplinar: string,
    mandato: string,
    pastoral: string,
    ocupacao: string,
    dispensa: string,
    diretoria: string,
    projeto: string;
  type Ata = { documento: string; versao: string };
  let ataConselho: Ata, ataJunta: Ata, ataEleicao: Ata, ataRestrita: Ata, outraAta: Ata, carta: Ata;

  const http = (metodo: 'post' | 'patch' | 'get' | 'delete', path: string, ator = 'gestor') =>
    request(app.getHttpServer())
      [metodo](path)
      .set('Cookie', cookies.get(ator)!)
      .set('Origin', 'http://localhost:3001')
      .set('X-Provisao-Request', '1');
  const ref = (grupo: string, id: string, etapa = 'ATO') => `/secretaria/referencias-ata/${grupo}/${id}/${etapa}`;
  const ligacao = (ata: Ata, revisao: string | null = null) => ({
    ata_documento_id: ata.documento,
    versao_id: ata.versao,
    justificativa: 'Conferência no acervo',
    revisao_esperada: revisao,
  });
  const pendente = { justificativa: 'Aguardando a ata', revisao_esperada: null };

  async function contextoOrgao(tipo: orgao_tipo, nome: string) {
    const orgao = await prisma.orgao_interno.create({
      data: {
        igreja_id: igreja,
        tipo,
        constituicao: tipo === 'UNIDADE_MINISTERIAL' ? 'DESIGNACAO' : 'OFICIAL',
        nome,
        sigla: nome,
        finalidade: 'Teste',
        data_criacao: dia,
        criador_id: gestor,
        instituidor_id: pessoa,
        evidencia_instituicao: 'Teste',
      },
    });
    const c = await prisma.contexto_secretaria.create({
      data: { igreja_id: igreja, tipo: 'ORGAO', orgao_id: orgao.id, nome, sigla: nome },
    });
    return { contexto: c.id, orgao: orgao.id };
  }

  async function documento(
    contexto_id: string,
    tipo: documento_tipo,
    igreja_id = igreja,
    restrito = false,
  ): Promise<Ata> {
    const m = await prisma.modelo_documento.create({ data: { contexto_id, igreja_id, nome: randomUUID() } });
    const mv = await prisma.modelo_documento_versao.create({
      data: { contexto_id, igreja_id, modelo_id: m.id, numero: 1, tipo, finalidade: 'TESTE', configuracao: {} },
    });
    const d = await prisma.documento.create({
      data: { contexto_id, igreja_id, tipo, restrito, perfil: randomUUID(), numero: 1234, ano: 2026, sigla: 'E09' },
    });
    const v = await prisma.documento_versao.create({
      data: {
        contexto_id,
        igreja_id,
        documento_id: d.id,
        numero: 1,
        modelo_versao_id: mv.id,
        assunto: 'Reunião de teste',
        data_documento: dia,
        conteudo: {},
      },
    });
    return { documento: d.id, versao: v.id };
  }

  function acesso(contexto_id: string) {
    return prisma.competencia_secretaria.create({
      data: {
        contexto_id,
        igreja_id: igreja,
        usuario_id: gestor,
        pessoa_id: pessoa,
        registrado_por_id: gestor,
        inicio: new Date('2020-01-01'),
        pode_aprovar: true,
        pode_deliberar: true,
        pode_consultar_restritos: true,
        autoridade: 'Igreja de teste',
        evidencia: 'E09',
      },
    });
  }

  beforeAll(async () => {
    if (
      process.env.DATABASE_URL !==
      'postgresql://provisao_test:provisao_test@127.0.0.1:55439/e09_integracao_codex?schema=public'
    ) {
      throw new Error('Use o banco exclusivo e descartável de E09.');
    }
    storage = await mkdtemp(join(tmpdir(), 'provisao-e09-'));
    Object.assign(process.env, {
      FEATURE_SECRETARIA: 'true',
      FEATURE_GOVERNANCA: 'true',
      FEATURE_ORGAOS: 'true',
      FEATURE_ORGAOS_GESTAO: 'true',
      FEATURE_SECRETARIA_ASSINATURAS: 'true',
      FEATURE_SECRETARIA_LIVROS: 'true',
      PRIVATE_STORAGE_ROOT: storage,
      FRONTEND_URL: 'http://localhost:3001',
    });
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.igreja.createMany({
      data: [
        { id: igreja, nome: 'E09' },
        { id: outraIgreja, nome: 'Outra igreja' },
      ],
    });
    const membroDisciplina = randomUUID(),
      liderUnidade = randomUUID();
    await prisma.pessoas.createMany({
      data: [pessoa, membro, membroDisciplina, liderUnidade].map((id) => ({
        id,
        igreja_id: igreja,
        nome_completo: id === membroDisciplina ? 'Identidade reservada' : 'Membro de teste',
        sexo: 'MASCULINO',
        data_nascimento: new Date('1980-01-01'),
      })),
    });
    for (const [nome, perfil, igreja_id, id] of [
      ['gestor', 'GESTOR', igreja, gestor],
      ['concedente', 'ADMINISTRADOR', igreja, concedente],
      ['auditor', 'AUDITOR', igreja, randomUUID()],
      ['tesoureiro', 'TESOUREIRO', igreja, randomUUID()],
      ['operador', 'OPERADOR', igreja, randomUUID()],
      ['outra', 'GESTOR', outraIgreja, randomUUID()],
    ] as const) {
      const u = await prisma.usuarios.create({
        data: {
          id,
          igreja_id,
          perfil,
          nome_usuario: nome,
          pessoa_id: id === gestor ? pessoa : null,
          email_login: `${id}@example.invalid`,
          senha_hash: 'teste',
        },
      });
      cookies.set(nome, 'provisao_session=' + (await app.get(SessionService).create(u.id, igreja_id, u.auth_version)));
    }
    conselho = (await contextoOrgao('CONSELHO', 'CON')).contexto;
    const ctxJunta = await contextoOrgao('JUNTA', 'JUN');
    junta = ctxJunta.contexto;
    unidade = (await contextoOrgao('UNIDADE_MINISTERIAL', 'UNI')).orgao;
    assembleia = (
      await prisma.contexto_secretaria.create({
        data: { igreja_id: igreja, tipo: 'ASSEMBLEIA_GERAL', nome: 'Assembleia', sigla: 'AG' },
      })
    ).id;
    const ctxOutra = await prisma.contexto_secretaria.create({
      data: { igreja_id: outraIgreja, tipo: 'ASSEMBLEIA_GERAL', nome: 'Outra Assembleia', sigla: 'AG' },
    });
    await Promise.all([acesso(conselho), acesso(assembleia)]);
    const [ata1, ata2, ata3, ata4, ata5, doc6] = await Promise.all([
      documento(conselho, 'ATA'),
      documento(junta, 'ATA'),
      documento(assembleia, 'ATA'),
      documento(conselho, 'ATA', igreja, true),
      documento(ctxOutra.id, 'ATA', outraIgreja),
      documento(conselho, 'OUTRO'),
    ]);
    [ataConselho, ataJunta, ataEleicao, ataRestrita, outraAta, carta] = [ata1, ata2, ata3, ata4, ata5, doc6];
    evento = (
      await prisma.eventos_membresia.create({
        data: {
          igreja_id: igreja,
          pessoa_id: membro,
          tipo_evento: 'ADMISSAO',
          rol: 'COMUNGANTES',
          motivacao_evento: 'PROFISSAO_DE_FE',
          data_evento: dia,
          ordem_dia: 1,
        },
      })
    ).id;
    disciplinar = (
      await prisma.eventos_membresia.create({
        data: {
          igreja_id: igreja,
          pessoa_id: membroDisciplina,
          tipo_evento: 'DEMISSAO',
          rol: 'EXCLUIDOS',
          motivacao_evento: 'EXCLUSAO_POR_DISCIPLINA',
          data_evento: dia,
          ordem_dia: 1,
        },
      })
    ).id;
    const of = await prisma.oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    const pastor = await prisma.oficial.create({
      data: { igreja_id: igreja, pessoa_id: pessoa, tipo: 'PRESBITERO_DOCENTE' },
    });
    mandato = (
      await prisma.mandato_oficial.create({
        data: {
          igreja_id: igreja,
          oficial_id: of.id,
          data_eleicao: dia,
          data_posse: dia,
          termino_previsto: new Date('2031-01-09'),
          autoridade: 'Assembleia',
          evidencia: 'Decisão registrada',
          avaliacao_eleicao: {},
        },
      })
    ).id;
    pastoral = (
      await prisma.vinculo_pastoral.create({
        data: {
          igreja_id: igreja,
          oficial_id: pastor.id,
          modalidade: 'DESIGNACAO',
          concilio: 'Presbitério',
          ato: 'Encaminhamento',
          data_inicio: dia,
          exercicio_institucional: true,
          evidencia: 'Item conferido',
        },
      })
    ).id;
    await prisma.eventos_membresia.create({
      data: {
        igreja_id: igreja,
        pessoa_id: liderUnidade,
        tipo_evento: 'ADMISSAO',
        rol: 'COMUNGANTES',
        motivacao_evento: 'PROFISSAO_DE_FE',
        data_evento: dia,
        ordem_dia: 1,
      },
    });
    const cargo = await prisma.cargo_orgao.create({
      data: { igreja_id: igreja, orgao_id: unidade, nome: 'Líder', codigo: 'LIDER' },
    });
    await prisma.presidencia_conselho.create({
      data: {
        igreja_id: igreja,
        oficial_id: pastor.id,
        inicio: dia,
        evidencia: 'Presidência conferida',
        registrado_por: concedente,
      },
    });
    await prisma.evento_oficial.create({
      data: {
        igreja_id: igreja,
        oficial_id: pastor.id,
        tipo: 'ORDENACAO',
        data_efeito: dia,
        ordem: 1,
        autoridade: 'Presbitério',
        evidencia: 'Ato conferido',
      },
    });
    const data_efeito = await hojeDaIgreja(prisma, igreja);
    const rota = `/orgaos/gestao/${unidade}/cargos/${cargo.id}/designacoes`;
    const designado = await http('post', rota)
      .send({
        pessoa_id: liderUnidade,
        data_efeito,
        ordem_efeito: 1,
        evidencia: 'Designação do presidente',
        idempotencia: randomUUID(),
      })
      .expect(201);
    ocupacao = designado.body.ocupacao_id;
    const dispensado = await http('post', rota)
      .send({
        pessoa_id: null,
        data_efeito,
        ordem_efeito: 2,
        evidencia: 'Dispensa pelo presidente',
        idempotencia: randomUUID(),
      })
      .expect(201);
    dispensa = dispensado.body.ato_id;
    diretoria = (
      await prisma.ato_orgao.create({
        data: {
          igreja_id: igreja,
          orgao_id: ctxJunta.orgao,
          operador_id: gestor,
          tipo: 'ELEICAO_CARGO',
          data_efeito: new Date('2026-01-11'),
          autoridade: 'Junta',
          evidencia: 'Ato registrado',
          detalhes: { data_eleicao: data },
        },
      })
    ).id;
    const conta = await prisma.contas.create({
      data: { igreja_id: igreja, descricao: 'Caixa de teste', tipo_conta: 'CAIXA' },
    });
    projeto = (
      await prisma.acoes.create({
        data: {
          igreja_id: igreja,
          nome: 'Projeto já cadastrado',
          responsavel_pessoa_id: pessoa,
          conta_id: conta.id,
          data_inicio: dia,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (storage) await rm(storage, { recursive: true, force: true });
  });

  it('rejeita OUTRO, igreja e contexto cruzados e preserva o histórico inclusive por cascata', async () => {
    const path = ref('MEMBRESIA', evento);
    const busca = await http('get', path + '/atas', 'auditor')
      .query({ numero: '1234/2026/E09', data, contexto: conselho })
      .expect(200);
    expect(busca.body.itens.map((x) => x.documento_id)).toEqual([ataConselho.documento]);
    for (const ruim of [carta, ataEleicao, outraAta]) await http('post', path).send(ligacao(ruim)).expect(400);
    await http('post', path).send({ ...ligacao(ataConselho), versao_id: ataEleicao.versao }).expect(400);
    await http('post', path, 'outra').send(ligacao(ataConselho)).expect(404);
    await http('post', path, 'auditor').send(ligacao(ataConselho)).expect(403);
    await http('post', path).send(ligacao(ataConselho)).expect(201);
    const atual = await http('get', path).expect(200);
    expect(atual.body).toMatchObject({
      situacao: 'MINUTA_VINCULADA',
      itens: [{ ata_documento_id: ataConselho.documento, versao_id: ataConselho.versao }],
    });
    const revisoes = await Promise.all(
      [1, 2].map(() =>
        http('post', path).send({ ...pendente, referencia_externa: externo, revisao_esperada: atual.body.itens[0].id }),
      ),
    );
    expect(revisoes.map((r) => r.status).sort()).toEqual([201, 409]);
    const historico = await http('get', path).expect(200);
    expect(historico.body.itens.map((x) => x.situacao)).toEqual(['EXTERNA_CONFERIDA', 'MINUTA_VINCULADA']);
    expect(await prisma.logs_atividades.count({ where: { igreja_id: igreja, tabela_afetada: 'referencia_ata' } })).toBe(
      2,
    );
    await expect(prisma.documento_versao.delete({ where: { id: ataConselho.versao } })).rejects.toMatchObject({
      code: 'P2003',
    });
    await expect(prisma.pessoas.delete({ where: { id: membro } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.referencia_ata_membresia.delete({ where: { id: historico.body.itens[1].id } })).rejects.toThrow(
      'Preserve o registro',
    );
    await expect(
      prisma.referencia_ata_membresia.create({
        data: {
          igreja_id: igreja,
          evento_id: evento,
          registrado_por_id: gestor,
          sequencia: 3,
          ata_documento_id: ataConselho.documento,
          versao_id: ataEleicao.versao,
          justificativa: 'Par incorreto',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    const inversa = await http('get', `/secretaria/documentos/${ataConselho.documento}/registros-vinculados`).expect(
      200,
    );
    expect(inversa.body.itens.some((x) => x.alvo_id === evento)).toBe(false);
  });

  it('filtra candidatos, atos e pendências antes de devolver resultados e paginação', async () => {
    const path = ref('MEMBRESIA', disciplinar);
    await http('get', path).expect(404);
    await prisma.acesso_eventos_sensiveis.create({
      data: {
        igreja_id: igreja,
        usuario_id: gestor,
        concedido_por_id: concedente,
        pode_consultar: true,
        pode_registrar: true,
        fundamento: 'Conferência de acervo disciplinar',
      },
    });
    await http('post', path).send(ligacao(ataConselho)).expect(400);
    await http('post', path).send(ligacao(ataRestrita)).expect(201);
    await http('get', path, 'auditor').expect(404);
    await http('get', `/secretaria/documentos/${ataRestrita.documento}/registros-vinculados`, 'auditor').expect(404);
    const pendencias = await http('get', '/secretaria/pendencias-documentais', 'auditor').expect(200);
    expect(JSON.stringify(pendencias.body)).not.toContain('Identidade reservada');
    const interno = await http('get', `/secretaria/documentos/${ataRestrita.documento}/registros-vinculados`).expect(
      200,
    );
    expect(interno.body.itens).toEqual([expect.objectContaining({ alvo_id: disciplinar })]);
  });

  it('separa eleição e posse de oficiais e de diretorias, preservando efeitos já registrados', async () => {
    await http('post', ref('MANDATO', mandato, 'ELEICAO'))
      .send(ligacao(ataEleicao))
      .expect(201);
    await http('post', ref('MANDATO', mandato, 'POSSE'))
      .send(ligacao(ataConselho))
      .expect(201);
    await http('post', ref('MANDATO', mandato, 'ENCERRAMENTO'))
      .send(pendente)
      .expect(404);
    const encerramento = await http('patch', `/oficiais/mandatos/${mandato}/encerrar`)
      .send({ data_efeito: '2026-01-11', motivo: 'Renúncia', autoridade: 'Conselho', evidencia: 'Renúncia registrada' })
      .expect(200);
    expect(encerramento.body.termino_efetivo).toContain('2026-01-11');
    await http('post', ref('MANDATO', mandato, 'ENCERRAMENTO'))
      .send(pendente)
      .expect(201);
    await http('post', ref('PASTORAL', pastoral, 'INICIO'))
      .send({ ...pendente, referencia_externa: externo })
      .expect(201);
    const novaAtaJunta = await documento(junta, 'ATA');
    await http('post', ref('ORGAO', diretoria, 'ELEICAO'))
      .send(ligacao(ataJunta))
      .expect(201);
    await http('post', ref('ORGAO', diretoria, 'POSSE'))
      .send(ligacao(ataConselho))
      .expect(400);
    await http('post', ref('ORGAO', diretoria, 'POSSE'))
      .send(ligacao(novaAtaJunta))
      .expect(201);
    const docDispensa = await http('post', ref('ORGAO', dispensa)).send(pendente).expect(201);
    const antes = await prisma.ocupacao_cargo.findUniqueOrThrow({ where: { id: ocupacao } });
    expect(antes.fim).not.toBeNull();
    expect(antes.fim_ordem).toBe(2);
    await http('post', ref('ORGAO', dispensa)).send(ligacao(ataConselho, docDispensa.body.id)).expect(201);
    expect(await prisma.ocupacao_cargo.findUnique({ where: { id: ocupacao } })).toEqual(antes);
    const pendencias = await http('get', '/secretaria/pendencias-documentais?grupo=ORGAO').expect(200);
    expect(pendencias.body.itens).toContainEqual(
      expect.objectContaining({ alvo_id: dispensa, situacao: 'MINUTA_VINCULADA' }),
    );
    const inversa = await http('get', `/secretaria/documentos/${ataConselho.documento}/registros-vinculados`).expect(
      200,
    );
    expect(inversa.body.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alvo_id: mandato, etapa: 'POSSE' }),
        expect.objectContaining({ alvo_id: dispensa, tipo: 'DISPENSA' }),
      ]),
    );
  });

  it('documenta decisão já tomada sem alterar orçamento, saldos ou permissões da Secretaria', async () => {
    const caixa = await prisma.acoes.findUniqueOrThrow({ where: { id: projeto } });
    const dados = {
      idempotencia: randomUUID(),
      tipo: 'APROVACAO_PROJETO',
      projeto_id: projeto,
      assunto: 'Autorização já aprovada',
      data_decisao: data,
      autoridade: 'Conselho',
      evidencia: 'Registro da reunião',
      decisao_ocorreu: true,
    };
    const path = '/secretaria/autorizacoes-financeiras';
    await http('post', path, 'tesoureiro')
      .send({ ...dados, decisao_ocorreu: false })
      .expect(400);
    await http('post', path, 'auditor').send(dados).expect(403);
    await http('post', path, 'outra').send(dados).expect(404);
    const { body } = await http('post', path, 'tesoureiro').send(dados).expect(201);
    expect((await http('post', path, 'tesoureiro').send(dados).expect(201)).body.id).toBe(body.id);
    await http('get', '/secretaria/contextos', 'tesoureiro').expect(403);
    await http('get', ref('MANDATO', mandato, 'ELEICAO'), 'tesoureiro').expect(404);
    await http('get', path, 'operador').expect(403);
    expect(await prisma.acoes.findUnique({ where: { id: projeto } })).toEqual(caixa);
    await http('post', ref('FINANCEIRO', body.id), 'tesoureiro').send(ligacao(ataRestrita)).expect(400);
    await http('post', ref('FINANCEIRO', body.id), 'tesoureiro').send(ligacao(ataEleicao)).expect(201);
    expect((await http('get', path, 'tesoureiro').query({ projeto }).expect(200)).body.itens).toEqual([
      expect.objectContaining({ id: body.id, situacao: 'MINUTA_VINCULADA' }),
    ]);
    await http('delete', `/acoes/${projeto}`).expect(409);
  });

  it('mantém lançamento rotineiro e edição de contato disponíveis sem ata', async () => {
    const acao = await prisma.acoes.findUniqueOrThrow({ where: { id: projeto } });
    await http('post', '/lancamentos', 'tesoureiro')
      .send({ conta_id: acao.conta_id, acao_id: projeto, data_transacao: data, valor: 25, tipo_transacao: 'RECEITA' })
      .expect(201);
    const atualizado = await http('patch', `/pessoas/${pessoa}`).send({ telefone_celular: '11912345678' }).expect(200);
    expect(atualizado.body.telefone_celular).toBe('11912345678');
  });

  it('atualiza para formalizada após expedição real da versão com resolução sem proponente', async () => {
    const comando = (revisao: number) => ({
      revisao,
      idempotencia: randomUUID(),
      autoridade: 'Assembleia',
      evidencia: 'Ato conferido',
    });
    const modelo = await http('post', '/secretaria/modelos')
      .send({
        tipo: 'ATA',
        finalidade: 'ATA_AGO',
        contexto_id: assembleia,
        nome: 'Modelo E09',
        idempotencia: randomUUID(),
        configuracao: {
          perfil: 'E09',
          contexto: 'ASSEMBLEIA_GERAL',
          motivador: 'NAO_PERMITE',
          resolucoes: 'OPCIONAL',
          campos_obrigatorios: [],
          papeis_obrigatorios: [],
          cargos_obrigatorios: [],
        },
      })
      .expect(201);
    const reuniao = await http('post', '/secretaria/reunioes')
      .send({
        contexto_id: assembleia,
        idempotencia: randomUUID(),
        dados: {
          restrito: false,
          modalidade: 'AGO',
          data,
          local: 'Templo',
          pauta: 'Deliberação',
          competencia: 'Assembleia',
          universo_informado: 1,
          quorum_minimo: 1,
          quorum_conferido: true,
          fundamento_quorum: 'Conferido',
          resultado: '',
          participantes: [{ pessoa_id: pessoa, presente: true, papeis: ['PRESIDENTE', 'SECRETARIO'] }],
        },
      })
      .expect(201);
    const criado = await http('post', '/secretaria/documentos')
      .send({
        contexto_id: assembleia,
        restrito: false,
        idempotencia: randomUUID(),
        versao: {
          modelo_versao_id: modelo.body.versao_id,
          reuniao_id: reuniao.body.id,
          motivador_id: null,
          assunto: 'Ata de eleição',
          data_documento: data,
          conteudo: {
            teor: 'Deliberação registrada.',
            campos: {},
            anexos: [],
            arrolados: [
              {
                pessoa_id: pessoa,
                papeis: ['PRESIDENTE', 'SECRETARIO'],
                cargo_id: null,
                assina: true,
                obrigatorio: true,
                responsavel: true,
                fundamento: 'Mesa',
              },
            ],
          },
          resolucoes: [
            {
              ordem: 1,
              assunto: 'Eleição',
              texto_proposta: null,
              texto_deliberado: 'Eleição registrada',
              resultado: 'APROVADA',
              eficaz: true,
              data_efeito: null,
              votacao_secreta: false,
              apuracao: null,
              proponentes_pessoas_ids: [],
              dissidentes_pessoas_ids: [],
            },
          ],
        },
      })
      .expect(201);
    const id = criado.body.id;
    const versao = (await http('get', `/secretaria/documentos/${id}`).expect(200)).body.versoes[0];
    const path = ref('MANDATO', mandato, 'ELEICAO');
    await http('post', path)
      .send(ligacao({ documento: id, versao: versao.id }, (await http('get', path).expect(200)).body.itens[0].id))
      .expect(201);
    expect((await http('get', path).expect(200)).body.situacao).toBe('MINUTA_VINCULADA');
    await http('post', `/secretaria/documentos/${id}/encaminhar`).send(comando(1)).expect(201);
    await http('post', `/secretaria/documentos/${id}/deliberar`)
      .send({ ...comando(2), data, reuniao_id: reuniao.body.id, resultado: 'APROVADA' })
      .expect(201);
    await http('post', `/secretaria/documentos/${id}/aprovar`)
      .send({ ...comando(3), modalidade: 'FISICA' })
      .expect(201);
    const aprovado = (await http('get', `/secretaria/documentos/${id}`).expect(200)).body;
    await app.get(RascunhosService).executarUm();
    const base = { versao_id: versao.id, revisao: aprovado.revisao };
    await http('post', `/secretaria/documentos/${id}/assinaturas/via`)
      .send({ ...base, idempotencia: randomUUID() })
      .expect(201);
    const via = (await http('get', `/secretaria/documentos/${id}/assinaturas/${versao.id}/arquivos/via`).expect(200))
      .body as Buffer;
    const scan = await PDFDocument.load(via);
    scan.getPages().at(-1)!.drawText('Conferencia E09', { x: 80, y: 70, size: 9 });
    await http('post', `/secretaria/documentos/${id}/assinaturas/fisica/conferir`)
      .field(
        'dados',
        JSON.stringify({
          ...base,
          idempotencia: randomUUID(),
          via_sha256: sha256(via),
          evidencia: 'Conferência local',
          assinaturas: [{ arrolado_id: aprovado.versoes[0].arrolados[0].id, data, evidencia: 'Firma conferida' }],
        }),
      )
      .attach('file', Buffer.from(await scan.save()), 'scan.pdf')
      .expect(201);
    await app.get(ExpedicaoWorkerService).executarUm();
    expect((await http('get', path).expect(200)).body.situacao).toBe('FORMALIZADA');
    const pendencias = await http('get', '/secretaria/pendencias-documentais?grupo=MANDATO').expect(200);
    expect(pendencias.body.itens.some((a) => a.alvo_id === mandato && a.etapa === 'ELEICAO')).toBe(false);
  });

  it('confere uma ata sem modelo, preserva sua referência e permite indexá-la em livro depois', async () => {
    const caminho = '/secretaria/atas-legadas';
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText('Teor do documento historico');
    const bytes = Buffer.from(await pdf.save());
    const upload = async (nome: string) =>
      (await http('post', '/arquivos-privados').attach('file', bytes, nome).expect(201)).body.id as string;
    const arquivo_id = await upload('ata-legada.pdf');
    const livroArquivo = await upload('livro-legado.pdf');
    const extrair = { contexto_id: conselho, arquivo_id };
    await http('post', caminho + '/teor', 'auditor')
      .send(extrair)
      .expect(403);
    if (spawnSync('pdftotext', ['-v']).error) {
      await http('post', caminho + '/teor')
        .send(extrair)
        .expect(503);
    } else {
      const resposta = await http('post', caminho + '/teor')
        .send(extrair)
        .expect(200);
      expect(resposta.body.teor).toBe('Teor do documento historico');
    }
    const entrada = {
      contexto_id: conselho,
      idempotencia: randomUUID(),
      numero_original: '004 bis',
      assunto: 'Ata histórica do Conselho',
      data_documento: data,
      restrito: false,
      reuniao: { data, local: 'Templo', modalidade: 'ORDINARIA', inicio: null, fim: null, pauta: null },
      teor: 'Teor conferido do documento histórico.',
      pdf: { arquivo_id, nome: 'ata-legada.pdf' },
      arrolados: [{ pessoa_id: pessoa, papeis: ['SECRETARIO'], fundamento: 'Assinatura no original' }],
      resolucoes: [
        {
          ordem: 1,
          assunto: 'Admissão',
          texto_deliberado: 'Receber membro conforme o registro.',
          resultado: 'APROVADA',
          proponentes_pessoas_ids: [pessoa],
        },
      ],
      autoridade: 'Secretaria',
      evidencia: 'Conferido com o acervo',
      conferida: true,
    };
    await http('post', caminho, 'auditor').send(entrada).expect(403);
    await http('post', caminho)
      .send({ ...entrada, conferida: false })
      .expect(400);
    const { id, revisao } = (await http('post', caminho).send(entrada).expect(201)).body;
    expect((await http('post', caminho).send(entrada).expect(201)).body).toEqual({ id, revisao });
    await http('post', caminho)
      .send({
        ...entrada,
        idempotencia: randomUUID(),
        pdf: { arquivo_id: await upload('duplicada.pdf'), nome: 'duplicada.pdf' },
      })
      .expect(409);

    const documento = '/secretaria/documentos/' + id;
    const detalhe = (await http('get', documento).expect(200)).body;
    expect(detalhe).toMatchObject({
      estado: 'LEGADA_CONFERIDA',
      numero: null,
      versoes: [
        {
          modelo_versao_id: null,
          numero_original: entrada.numero_original,
          livro_id: null,
          conteudo: { teor: entrada.teor },
          fonte_congelada: { legado: { reuniao: { local: 'Templo' }, sha256: sha256(bytes) } },
          arrolados: [{ pessoa_id: pessoa, papeis: ['SECRETARIO'] }],
          resolucoes: [{ assunto: 'Admissão', proponentes: [{ arrolado: { pessoa_id: pessoa } }] }],
        },
      ],
    });
    const versao = detalhe.versoes[0].id;
    await expect(
      prisma.documento_versao.update({
        where: { id: versao },
        data: { assunto: 'Alteração após conferência' },
      }),
    ).rejects.toThrow('Versão documental congelada é imutável');
    const anexo = documento + '/versoes/' + versao + '/anexos/' + arquivo_id;
    expect((await http('get', anexo).expect(200)).body).toEqual(bytes);
    await http('get', anexo, 'outra').expect(404);
    const path = ref('MEMBRESIA', evento);
    const busca = await http('get', path + '/atas')
      .query({ numero: '004 bis', data, contexto: conselho })
      .expect(200);
    expect(busca.body.itens).toEqual([expect.objectContaining({ documento_id: id, numero_formatado: '004 bis' })]);

    const { id: livro } = (
      await http('post', '/secretaria/livros/importar')
        .send({
          contexto_id: conselho,
          idempotencia: randomUUID(),
          numero: 3,
          serie: 'ATA_PADRAO',
          capacidade_folhas: 5,
          faces_por_folha: 1,
          fonte_normativa: 'Registro histórico',
          restrito: false,
          arquivo_historico_id: livroArquivo,
          data_historica: data,
          autoridade: 'Secretaria',
          evidencia: 'Livro original digitalizado',
        })
        .expect(201)
    ).body;
    const livros = (
      await http('get', '/secretaria/livros')
        .query({
          contexto: conselho,
          estado: 'ENCERRADO',
          modalidade: 'FISICO_DIGITALIZADO',
          restrito: false,
        })
        .expect(200)
    ).body;
    expect(livros.map((l) => l.id)).toContain(livro);
    await http('post', caminho + '/' + id + '/livro')
      .send({
        idempotencia: randomUUID(),
        revisao,
        livro_id: livro,
        folhas: '2–3',
        autoridade: 'Secretaria',
        evidencia: 'Numeração visível',
      })
      .expect(201);
    expect((await http('get', '/secretaria/livros/' + livro).expect(200)).body).toMatchObject({
      atas_legadas: [{ documento_id: id, folhas_legadas: '2–3' }],
      registros: [],
      manifesto_sha256: null,
    });

    const referenciaLegada = ref('MEMBRESIA', evento);
    const anterior = (await http('get', referenciaLegada).expect(200)).body.itens[0]?.id ?? null;
    await http('post', referenciaLegada).send(ligacao({ documento: id, versao }, anterior)).expect(201);
    const referencia = (await http('get', referenciaLegada).expect(200)).body;
    expect(referencia.situacao).toBe('LEGADA_CONFERIDA');
    expect(referencia.itens[0]).toMatchObject({
      ata_documento_id: id, versao_id: versao, ata: { numero_formatado: '004 bis' },
    });
  });
});
