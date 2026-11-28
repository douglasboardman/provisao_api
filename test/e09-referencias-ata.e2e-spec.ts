import { configuracaoSchema } from '../src/secretaria/secretaria.dto';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { documento_tipo, orgao_tipo } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { seedSecretaria } from '../prisma/seed-secretaria';
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
  const concedente = randomUUID(), conselheiro = randomUUID(), pessoaConselheiro = randomUUID();
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

  async function planejamento(contexto_id: string) {
    const modelo = await prisma.modelo_reuniao.create({ data: {
      igreja_id: igreja, contexto_id, finalidade: 'Reunião de teste ' + randomUUID(),
      configuracao: { tipo: 'Ordinária', natureza: 'Mista', obrigatoria: false,
        periodicidade: 'Conforme a necessidade', referencia: 'Integrantes do órgão/unidade',
        orgaos_participantes: [], primeira: 'Qualquer número', segunda: 'Não prevista',
        antecedencia_dias: null, intervalo_minutos: null, minimo_anual: null,
        colegiado: 'Colegiado', fundamentacao: 'Configuração de teste', observacao: '' },
    } });
    return { modelo_reuniao_id: modelo.id, formato: 'Presencial', carater: 'Regular', convocacao: 'Primeira' };
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
        { id: igreja, nome: 'E09', mfa_obrigatorio: false },
        { id: outraIgreja, nome: 'Outra igreja', mfa_obrigatorio: false },
      ],
    });
    const membroDisciplina = randomUUID(),
      liderUnidade = randomUUID();
    await prisma.pessoas.createMany({
      data: [pessoa, membro, membroDisciplina, liderUnidade, pessoaConselheiro].map((id) => ({
        id,
        igreja_id: igreja,
        nome_completo: id === membroDisciplina ? 'Identidade reservada' : 'Membro de teste',
        sexo: 'MASCULINO',
        data_nascimento: new Date('1980-01-01'),
      })),
    });
    for (const [nome, perfil, igreja_id, id] of [
      ['gestor', 'ADMINISTRADOR', igreja, gestor],
      ['presidente', 'COMUM', igreja, randomUUID()],
      ['conselheiro', 'COMUM', igreja, conselheiro],
      ['concedente', 'ADMINISTRADOR', igreja, concedente],
      ['auditor', 'AUDITOR', igreja, randomUUID()],
      ['secretario', 'COMUM', igreja, randomUUID()],
      ['secretarioOutra', 'COMUM', outraIgreja, randomUUID()],
      ['tesoureiro', 'COMUM', igreja, randomUUID()],
      ['operador', 'COMUM', igreja, randomUUID()],
      ['outra', 'ADMINISTRADOR', outraIgreja, randomUUID()],
    ] as const) {
      const pessoaConta = id === gestor || nome === 'presidente' ? pessoa : id === conselheiro ? pessoaConselheiro : (await prisma.pessoas.create({ data: { igreja_id, nome_completo: nome, sexo: 'MASCULINO', data_nascimento: new Date('1980-01-01') } })).id;
      const u = await prisma.usuarios.create({
        data: {
          id,
          igreja_id,
          perfil,
          nome_usuario: nome,
          pessoa_id: pessoaConta,
          conta_atuacao: nome.startsWith('secretario') || nome === 'presidente',
          email_login: `${id}@example.invalid`,
          senha_hash: 'teste',
        },
      });
      const acoes = nome === 'operador' || perfil === 'ADMINISTRADOR' ? [] : [
        'VINCULOS_DOCUMENTAIS_CONSULTAR',
        ...(perfil === 'AUDITOR' ? ['AUTORIZACOES_FINANCEIRAS_CONSULTAR'] : ['VINCULOS_DOCUMENTAIS_REGISTRAR']),
        ...(['tesoureiro', 'outra'].includes(nome) ? ['AUTORIZACOES_FINANCEIRAS_CONSULTAR', 'AUTORIZACOES_FINANCEIRAS_REGISTRAR', 'LANCAMENTOS_REGISTRAR', 'PESSOAS_EDITAR'] : []),
      ];
      for (const acao of acoes) await prisma.atribuicao_servico.create({ data: { igreja_id, usuario_id: u.id, pessoa_id: pessoaConta, geracao_vinculo: u.geracao_vinculo, acao, inicio: new Date('2020-01-01') } });
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
    await Promise.all([acesso(conselho), acesso(assembleia), acesso(junta)]);
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
    const secretarioJunta = await prisma.pessoas.create({ data: { igreja_id: igreja, nome_completo: 'Secretário da Junta', sexo: 'MASCULINO', data_nascimento: new Date('1980-01-01') } });
    await prisma.usuarios.updateMany({ where: { igreja_id: igreja, nome_usuario: 'secretario' }, data: { pessoa_id: secretarioJunta.id } });
    await prisma.usuarios.updateMany({ where: { igreja_id: igreja, nome_usuario: 'secretario' }, data: { conta_atuacao: true } });
    const secretarioAtual = await prisma.usuarios.findFirstOrThrow({ where: { igreja_id: igreja, nome_usuario: 'secretario' } });
    await prisma.atribuicao_servico.updateMany({ where: { usuario_id: secretarioAtual.id }, data: { pessoa_id: secretarioJunta.id, geracao_vinculo: secretarioAtual.geracao_vinculo } });
    cookies.set('secretario', 'provisao_session=' + await app.get(SessionService).create(secretarioAtual.id, igreja, secretarioAtual.auth_version));
    const diacono = await prisma.oficial.create({ data: { igreja_id: igreja, pessoa_id: secretarioJunta.id, tipo: 'DIACONO' } });
    await prisma.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: secretarioJunta.id, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: dia, referencia_documental: 'Registro de teste' } });
    await prisma.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: diacono.id, tipo: 'ORDENACAO', data_efeito: dia, ordem: 1, autoridade: 'Conselho', evidencia: 'Ato conferido' } });
    await prisma.mandato_oficial.create({ data: { igreja_id: igreja, oficial_id: diacono.id, data_eleicao: dia, data_posse: dia, termino_previsto: new Date('2031-01-09'), autoridade: 'Assembleia', evidencia: 'Ata', avaliacao_eleicao: {} } });
    const cargoJunta = await prisma.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: ctxJunta.orgao, codigo: 'SECRETARIO', funcao: 'SECRETARIO', nome: 'Primeiro secretário' } });
    await prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: ctxJunta.orgao, pessoa_id: secretarioJunta.id, cargo_id: cargoJunta.id, inicio: dia, termino_previsto: new Date('2027-01-09') } });
    const pastor = await prisma.oficial.create({
      data: { igreja_id: igreja, pessoa_id: pessoa, tipo: 'PRESBITERO_DOCENTE', ativo: false },
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
    const designado = await http('post', rota, 'presidente')
      .send({
        pessoa_id: liderUnidade,
        data_efeito,
        ordem_efeito: 1,
        evidencia: 'Designação do presidente',
        idempotencia: randomUUID(),
      })
      .expect(201);
    ocupacao = designado.body.ocupacao_id;
    const dispensado = await http('post', rota, 'presidente')
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
    await http('post', path).send(ligacao(ataRestrita)).expect(400);
    const docente = await prisma.oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoaConselheiro, tipo: 'PRESBITERO_DOCENTE' } });
    await prisma.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: docente.id, tipo: 'ORDENACAO', data_efeito: dia,
      ordem: 1, autoridade: 'Presbitério', evidencia: 'Ata de ordenação' } });
    await prisma.vinculo_pastoral.create({ data: { igreja_id: igreja, oficial_id: docente.id, data_inicio: dia, exercicio_institucional: true,
      modalidade: 'Pastor', concilio: 'Presbitério', ato: 'Posse', evidencia: 'Ata de posse' } });
    await http('get', path, 'conselheiro').expect(404);
    await prisma.acesso_eventos_sensiveis.create({ data: { igreja_id: igreja, usuario_id: conselheiro, concedido_por_id: concedente,
      pode_consultar: true, pode_registrar: true, fundamento: 'Conferência disciplinar' } });
    await http('post', path, 'conselheiro').send(ligacao(ataRestrita)).expect(201);
    await http('get', path, 'auditor').expect(404);
    await http('get', `/secretaria/documentos/${ataRestrita.documento}/registros-vinculados`, 'auditor').expect(404);
    const pendencias = await http('get', '/secretaria/pendencias-documentais', 'auditor').expect(200);
    expect(JSON.stringify(pendencias.body)).not.toContain('Identidade reservada');
    const interno = await http('get', `/secretaria/documentos/${ataRestrita.documento}/registros-vinculados`, 'conselheiro').expect(
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
    const ataEncerramento = await documento(conselho, 'ATA');
    await prisma.documento.update({ where: { id: ataEncerramento.documento }, data: { estado: 'APROVADO' } });
    const encerramento = await http('patch', `/oficiais/mandatos/${mandato}/encerrar`, 'concedente')
      .send({ data_efeito: '2026-01-11', motivo: 'Renúncia', ata_encerramento: ataEncerramento.versao })
      .expect(200);
    expect(encerramento.body.termino_efetivo).toContain('2026-01-11');
    await http('get', ref('MANDATO', mandato, 'ENCERRAMENTO')).expect(200)
      .expect(r => expect(r.body.itens[0].versao_id).toBe(ataEncerramento.versao));
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
    expect((await http('get', '/secretaria/contextos', 'tesoureiro').expect(200)).body).toEqual([]);
    await http('get', ref('MANDATO', mandato, 'ELEICAO'), 'tesoureiro').expect(200);
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
        publicar: true,
        tipo: 'ATA',
        finalidade: 'ATA_AGO',
        contexto_id: assembleia,
        nome: 'Modelo E09',
        idempotencia: randomUUID(),
        configuracao: {
          perfil: 'E09',
          atuacao: { criar: ['PRESIDENCIA_CONSELHO'], preparar: [], assinar: [] },
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
          ...await planejamento(assembleia),
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
            efetivos: { inicio: '2026-01-10T12:00:00Z', fim: '2026-01-10T13:00:00Z', local: 'Templo', presentes: 1, habilitados_presentes: 1, universo: 1 },
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
    // Retificar uma ata expedida cria outro documento e também oferece reatribuição.
    const expedida = (await http('get', `/secretaria/documentos/${id}`).expect(200)).body;
    const atos = (await http('get', `/secretaria/documentos/${id}/atos-para-reatribuir`).expect(200)).body;
    const retificacao = { ...comando(expedida.revisao),
      reatribuicao_atos: { vistas: atos.map(a => a.referencia_id), selecionadas: atos.map(a => a.referencia_id) },
      versao: { modelo_versao_id: versao.modelo_versao_id, assunto: 'Ata retificada', data_documento: data,
        reuniao_id: reuniao.body.id, motivador_id: null, livro_id: null, conteudo: versao.conteudo },
    };
    const nova = (await http('post', `/secretaria/documentos/${id}/retificar`).send(retificacao).expect(201)).body;
    expect(nova.id).not.toBe(id);
    const revisoes = (await http('get', path).expect(200)).body.itens;
    expect(revisoes[0].ata_documento_id).toBe(nova.id);
    expect(revisoes[1].versao_id).toBe(versao.id);

  });

  it('mantém um rascunho por modelo e bloqueia a criação durante toda a edição', async () => {
    const base = { tipo: 'OUTRO', finalidade: 'CARTA', configuracao: {
      perfil: 'CARTA', contexto: 'ASSEMBLEIA_GERAL', motivador: 'OPCIONAL', resolucoes: 'NAO_PERMITE',
      atuacao: { criar: ['PRESIDENCIA_CONSELHO'], preparar: [], assinar: [] },
      campos_obrigatorios: [], papeis_obrigatorios: [], cargos_obrigatorios: [],
    } };
    const modelo = (await http('post', '/secretaria/modelos').send({ ...base, nome: 'Carta de teste',
      contexto_id: assembleia, idempotencia: randomUUID() }).expect(201)).body;
    const url = '/secretaria/modelos/' + modelo.id;
    const ler = async () => (await http('get', '/secretaria/modelos?contexto=' + assembleia).expect(200)).body.find(m => m.id === modelo.id);
    const dados = (revisao: number) => ({ ...base, revisao, idempotencia: randomUUID() });
    const versao = (modelo_versao_id: string) => ({ modelo_versao_id, assunto: 'Carta', data_documento: data,
      conteudo: { campos: {}, teor: 'Texto original', anexos: [], arrolados: [] } });
    const gerar = (id: string, vigente = true) => http('post', '/secretaria/documentos').send({
      contexto_id: assembleia, restrito: false, ...(vigente && { usar_modelo_vigente: true }), idempotencia: randomUUID(), versao: versao(id),
    });
    expect(await ler()).toMatchObject({ estado: 'EM_EDICAO', versoes: [] });
    await http('patch', url + '/rascunho').send(dados(1)).expect(200);
    await http('patch', url + '/rascunho').send(dados(2)).expect(200);
    expect((await ler()).versoes).toHaveLength(0);
    const v1 = (await http('post', url + '/publicar').send(dados(3)).expect(201)).body.versao_id;
    const doc = (await gerar(v1).expect(201)).body;
    expect(await ler()).toMatchObject({ estado: 'PUBLICADO', rascunho: null, versoes: [{ numero: 1 }] });
    await http('post', url + '/editar', 'auditor').send({ revisao: 4, idempotencia: randomUUID() }).expect(403);
    await http('post', url + '/editar').send({ revisao: 4, idempotencia: randomUUID() }).expect(201);
    await gerar(v1).expect(409);
    await gerar(v1, false).expect(409);
    await http('patch', '/secretaria/documentos/' + doc.id).send({ revisao: 1, idempotencia: randomUUID(), versao: versao(v1) }).expect(200);
    await http('patch', url + '/rascunho').send({ ...dados(5), finalidade: 'OFICIO' }).expect(200);
    expect(await ler()).toMatchObject({ estado: 'EM_EDICAO', rascunho: { finalidade: 'OFICIO' }, versoes: [{ id: v1, finalidade: 'CARTA' }] });
    await http('post', url + '/publicar').send(dados(5)).expect(409);
    const publicar = { ...dados(6), finalidade: 'OFICIO' };
    const v2 = (await http('post', url + '/publicar').send(publicar).expect(201)).body.versao_id;
    expect((await http('post', url + '/publicar').send(publicar).expect(201)).body.versao_id).toBe(v2);
    expect((await ler()).versoes.map(v => v.numero)).toEqual([2, 1]);
    await gerar(v2).expect(201);
    expect((await http('get', '/secretaria/documentos/' + doc.id)).body.versoes[0].modelo_versao_id).toBe(v1);
  });

  it('preenche as duas formas do número no primeiro encaminhamento válido', async () => {
    const campos = await prisma.campo_secretaria.findMany({ where: { igreja_id: igreja, origem: { in: ['numero_documento', 'numero_documento_por_extenso'] } } });
    expect(campos).toHaveLength(2);
    const modelos = await seedSecretaria(prisma, igreja, conselho, concedente);
    const modeloBase = await prisma.modelo_documento_versao.findUniqueOrThrow({ where: { id: modelos.CORRESPONDENCIA } });
    const config = configuracaoSchema.parse(modeloBase.configuracao);
    const composicao = { ...config.composicao_padrao, corpo: [{ tipo: 'paragrafo', alinhamento: 'esquerda',
      trechos: campos.map(c => ({ tipo: 'campo', campo_id: c.id, apresentacao: 'individual' })) }] };
    const modelo = (await http('post', '/secretaria/modelos').send({ publicar: true, contexto_id: conselho, idempotencia: randomUUID(),
      nome: 'Documento numerado', tipo: 'OUTRO', finalidade: 'CORRESPONDENCIA',
      configuracao: { ...config, composicao_padrao: composicao, obrigatorios_biblioteca: campos.map(c => c.id), papeis_obrigatorios: [] },
    }).expect(201)).body;
    const versao = { modelo_versao_id: modelo.versao_id, data_documento: data, assunto: 'Correspondência de teste',
      conteudo: { composicao, teor: '', campos: {}, anexos: [], arrolados: [] } };
    const criado = (await http('post', '/secretaria/documentos').send({ contexto_id: conselho, restrito: false, idempotencia: randomUUID(), versao }).expect(201)).body;
    const url = '/secretaria/documentos/' + criado.id;
    const comando = (revisao: number) => ({ revisao, idempotencia: randomUUID(), autoridade: 'Conselho', evidencia: 'Conferência' });
    await http('post', url + '/encaminhar').send(comando(1)).expect(400);
    const minuta = (await http('get', url).expect(200)).body;
    expect(minuta.numero).toBeNull();
    expect(minuta.tramitacao.pendencias.map(p => p.destino)).not.toContain('teor');
    for (const c of campos) {
      expect(minuta.versoes[0].conteudo.valores[c.id].valor).toBeNull();
      expect(minuta.tramitacao.pendencias.map(p => p.destino)).not.toContain('valor-' + c.id);
    }
    const arrolados = [{ pessoa_id: pessoa, papeis: ['SECRETARIO'], cargo_id: null, assina: true, obrigatorio: true, responsavel: true, fundamento: 'Secretário' }];
    const editar = (revisao: number) => http('patch', url).send({ revisao, idempotencia: randomUUID(), versao: { ...versao, conteudo: { ...versao.conteudo, arrolados } } }).expect(200);
    await editar(1);
    await http('post', url + '/encaminhar').send(comando(2)).expect(201);
    async function conferirNumero() {
      const doc = (await http('get', url).expect(200)).body;
      expect(doc.numero).toBe(1);
      for (const c of campos) {
        expect(doc.versoes[0].conteudo.valores[c.id]).toMatchObject({
          valor: c.origem === 'numero_documento' ? 1 : 'um', origem: { tipo: 'sistema', chave: c.origem },
        });
      }
    }
    await conferirNumero();
    await editar(3);
    await http('post', url + '/encaminhar').send(comando(4)).expect(201);
    await conferirNumero();
  });

  it.each(['Conselho', 'Junta Diaconal'])('leva os itens da reunião regular de %s à ata na ordem cadastrada', async nome => {
    const contexto_id = nome === 'Conselho' ? conselho : junta;
    const itens = [
      { descricao: 'Leitura da correspondência', proponente_id: pessoa },
      { descricao: 'Planejamento do encontro', proponente_id: null },
    ];
    const dados = {
      ...await planejamento(contexto_id),
      restrito: false, modalidade: 'REGULAR', data, local: 'Templo', competencia: nome,
      universo_informado: 0, quorum_minimo: 0, quorum_conferido: false, fundamento_quorum: 'Cadastro',
      resultado: '', participantes: [], itens_pauta: itens,
    };
    const criar = (dadosReuniao: typeof dados) => http('post', '/secretaria/reunioes')
      .send({ contexto_id, idempotencia: randomUUID(), dados: dadosReuniao });
    await criar({ ...dados, itens_pauta: [{ ...itens[0], proponente_id: randomUUID() }] }).expect(400);
    const { body: reuniao } = await criar(dados).expect(201);
    const caminho = '/secretaria/reunioes/' + reuniao.id;
    const inicial = (await http('get', caminho).expect(200)).body;
    expect(inicial.itens_pauta).toMatchObject(itens.map((item, i) => ({ ...item, ordem: i + 1 })));
    expect(inicial.itens_pauta[0].proponente.nome_completo).toBe('Membro de teste');
    await http('patch', caminho).send({ revisao: 1, idempotencia: randomUUID(), dados: { ...inicial.dados, pauta: 'Mudança por editor antigo' } }).expect(409);
    const invertidos = [itens[1], itens[0]];
    await http('patch', caminho).send({ revisao: 1, idempotencia: randomUUID(), dados: { ...dados, itens_pauta: invertidos } }).expect(200);
    expect((await http('get', caminho).expect(200)).body.itens_pauta).toMatchObject(invertidos.map((item, i) => ({ ...item, ordem: i + 1 })));
    const modelos = await seedSecretaria(prisma, igreja, contexto_id, concedente);
    const modelo = await prisma.modelo_documento_versao.findUniqueOrThrow({ where: { id: modelos.ATA_REUNIAO } });
    const campo = await prisma.campo_secretaria.findFirstOrThrow({ where: { igreja_id: igreja, origem: 'pauta_reuniao' } });
    const { composicao_padrao } = modelo.configuracao as { composicao_padrao: object };
    const { body: ata } = await http('post', '/secretaria/documentos', nome === 'Conselho' ? 'gestor' : 'secretario').send({
      contexto_id, restrito: false, idempotencia: randomUUID(), versao: {
        modelo_versao_id: modelo.id, reuniao_id: reuniao.id, motivador_id: null,
        assunto: 'Ata da reunião regular', data_documento: data,
        conteudo: { teor: '', composicao: composicao_padrao, campos: {}, anexos: [], arrolados: [] },
      },
    }).expect(201);
    const versao = (await http('get', '/secretaria/documentos/' + ata.id).expect(200)).body.versoes[0];
    expect(versao.conteudo.valores[campo.id].valor).toEqual(invertidos.map(i => i.descricao));
  });

  it('seleciona um local da igreja e conserva o endereço e usa a data da reunião por extenso na ata', async () => {
    await prisma.configuracao_fuso_igreja.upsert({ where: { igreja_id: igreja }, create: { igreja_id: igreja, fuso_iana: 'America/Sao_Paulo' }, update: { fuso_iana: 'America/Sao_Paulo' } });
    const local = {
      descritivo: 'Templo', endereco_logradouro: 'Rua General Câmara', endereco_numero: '2786',
      endereco_bairro: 'Centro', endereco_cep: '97500283', endereco_cidade: 'Uruguaiana', endereco_uf: 'RS',
    };
    const pedido = { local, idempotencia: randomUUID() };
    const cadastro = (await http('post', '/secretaria/locais').send(pedido).expect(201)).body;
    expect((await http('post', '/secretaria/locais').send(pedido).expect(201)).body.id).toBe(cadastro.id);
    const caminho = '/secretaria/locais/' + cadastro.id;
    const localidades = (await http('get', '/secretaria/locais').expect(200)).body;
    const encontrado = localidades.find(l => l.id === cadastro.id);
    expect(encontrado.endereco_extenso).toBe('Rua General Câmara, 2786 - Bairro Centro, CEP 97500-283, Uruguaiana/RS');
    expect(encontrado.endereco_declarativo).toBe('sito à Rua General Câmara, número 2786, Bairro Centro, CEP 97500-283, em Uruguaiana, Rio Grande do Sul');
    expect((await http('get', '/secretaria/locais', 'outra').expect(200)).body).not.toContainEqual(expect.objectContaining({ id: cadastro.id }));
    const localOutra = (await http('post', '/secretaria/locais', 'outra').send(pedido).expect(201)).body;
    const dados = {
      ...await planejamento(conselho),
      restrito: false, modalidade: 'REGULAR', data: '2025-12-01', inicio: '2025-12-01T22:30:00Z', fim: '2025-12-02T01:01:00Z', competencia: 'Conselho', pauta: 'Visitas',
      universo_informado: 0, quorum_minimo: 0, quorum_conferido: false, fundamento_quorum: 'Cadastro',
      resultado: '', participantes: [],
    };
    const criar = (local_id: string) => http('post', '/secretaria/reunioes').send({
      contexto_id: conselho, dados, local_id, idempotencia: randomUUID(),
    });
    await criar(localOutra.id).expect(400);
    const reuniao = (await criar(cadastro.id).expect(201)).body;
    const editar = { revisao: 1, idempotencia: randomUUID(), local: { ...local, descritivo: 'Sede', declarativo_personalizado: 'nas dependências da sede' } };
    await http('patch', caminho, 'auditor').send(editar).expect(403);
    await http('patch', caminho).send(editar).expect(200);
    await http('patch', caminho).send({ ...editar, idempotencia: randomUUID() }).expect(409);
    const outraReuniao = (await criar(cadastro.id).expect(201)).body;
    expect((await http('get', '/secretaria/reunioes/' + outraReuniao.id).expect(200)).body.local_retrato.endereco_declarativo).toBe('nas dependências da sede');
    await http('patch', '/secretaria/reunioes/' + reuniao.id).send({ dados, local_id: cadastro.id, revisao: 1, idempotencia: randomUUID() }).expect(200);
    const modelos = await seedSecretaria(prisma, igreja, conselho, concedente);
    const base = await prisma.modelo_documento_versao.findUniqueOrThrow({ where: { id: modelos.ATA_REUNIAO } });
    const config = configuracaoSchema.parse(base.configuracao);
    const campos = await prisma.campo_secretaria.findMany({ where: { igreja_id: igreja, origem: { in: ['local_reuniao', 'endereco_declarativo', 'endereco_extenso', 'endereco_uf', 'dia_reuniao_por_extenso', 'mes_reuniao_por_extenso', 'ano_reuniao_por_extenso', 'horario_inicio_reuniao', 'horario_inicio_reuniao_por_extenso', 'horario_encerramento_reuniao', 'horario_encerramento_reuniao_por_extenso', 'redator_ata'] } } });
    expect(campos).toHaveLength(12);
    const composicao = { ...config.composicao_padrao, corpo: campos.map(c => ({ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'campo', campo_id: c.id, apresentacao: 'individual' }] })) };
    const modelo = (await http('post', '/secretaria/modelos').send({ publicar: true, contexto_id: conselho, idempotencia: randomUUID(),
      nome: 'Ata com endereço', tipo: 'ATA', finalidade: 'ATA_REUNIAO', configuracao: { ...config, composicao_padrao: composicao },
    }).expect(201)).body;
    const versaoAta = { modelo_versao_id: modelo.versao_id, reuniao_id: reuniao.id, assunto: 'Ata com endereço', data_documento: '2026-02-01',
      conteudo: { teor: '', composicao, campos: {}, anexos: [], arrolados: [] } };
    const criarAta = (pessoa_id: string) => http('post', '/secretaria/documentos').send({ contexto_id: conselho, restrito: false, idempotencia: randomUUID(),
      versao: { ...versaoAta, conteudo: { ...versaoAta.conteudo, redator_ata: { pessoa_id, nome: 'Nome fornecido pelo cliente' } } } });
    const externo = await prisma.pessoas.create({ data: { igreja_id: outraIgreja, nome_completo: 'Outra igreja', sexo: 'MASCULINO', data_nascimento: dia } });
    await criarAta(externo.id).expect(400);
    const ata = (await criarAta(membro).expect(201)).body;
    const urlAta = '/secretaria/documentos/' + ata.id;
    const salva = (await http('get', urlAta).expect(200)).body.versoes[0].conteudo;
    expect(salva.redator_ata).toEqual({ pessoa_id: membro, nome: 'Membro de teste' });
    const valores = salva.valores;
    const esperados = { ...encontrado, redator_ata: 'Membro de teste', local_reuniao: 'Templo', dia_reuniao_por_extenso: 'primeiro', mes_reuniao_por_extenso: 'dezembro', ano_reuniao_por_extenso: 'dois mil e vinte e cinco',
      horario_inicio_reuniao: '19:30', horario_inicio_reuniao_por_extenso: 'dezenove horas e trinta minutos',
      horario_encerramento_reuniao: '22:01', horario_encerramento_reuniao_por_extenso: 'vinte e duas horas e um minuto' };
    for (const c of campos) expect(valores[c.id].valor).toBe(esperados[c.origem]);
    const campoRedator = campos.find(c => c.origem === 'redator_ata')!;
    await http('patch', urlAta).send({ revisao: 1, idempotencia: randomUUID(), versao: versaoAta }).expect(200);
    expect((await http('get', urlAta).expect(200)).body.versoes[0].conteudo.redator_ata).toEqual(salva.redator_ata);
    await http('patch', urlAta).send({ revisao: 2, idempotencia: randomUUID(),
      versao: { ...versaoAta, conteudo: { ...versaoAta.conteudo, redator_ata: null } } }).expect(200);
    expect((await http('get', urlAta).expect(200)).body.versoes[0].conteudo.valores[campoRedator.id].valor).toBeNull();
  });

  it('vincula uma reunião ordinária do Conselho à ata legada e preserva sua referência', async () => {
    // Conta institucional: cargo vigente de secretário, com perfil COMUM.
    const institucional = await prisma.pessoas.create({ data: { igreja_id: igreja, nome_completo: 'Secretaria institucional',
      sexo: 'MASCULINO', data_nascimento: new Date('1980-01-01') } });
    const conta = await prisma.usuarios.create({ data: { igreja_id: igreja, pessoa_id: institucional.id,
      nome_usuario: 'Secretaria institucional', email_login: randomUUID() + '@example.invalid', senha_hash: 'inutilizavel',
      perfil: 'COMUM', conta_atuacao: true } });
    cookies.set('secretariaInstitucional', 'provisao_session=' + await app.get(SessionService).create(conta.id, igreja, conta.auth_version));
    const oficialSecretario = await prisma.oficial.create({ data: { igreja_id: igreja, pessoa_id: institucional.id, tipo: 'PRESBITERO_REGENTE' } });
    await prisma.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: institucional.id, tipo_evento: 'ADMISSAO',
      rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: dia, referencia_documental: 'Registro de teste' } });
    await prisma.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficialSecretario.id, tipo: 'ORDENACAO',
      data_efeito: dia, ordem: 1, autoridade: 'Concílio', evidencia: 'Registro' } });
    await prisma.mandato_oficial.create({ data: { igreja_id: igreja, oficial_id: oficialSecretario.id, data_eleicao: dia,
      data_posse: dia, termino_previsto: new Date('2031-01-09'), autoridade: 'Assembleia', evidencia: 'Ata', avaliacao_eleicao: {} } });
    const orgao = (await prisma.contexto_secretaria.findUniqueOrThrow({ where: { id: conselho } })).orgao_id;
    const cargo = await prisma.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao,
      codigo: 'SECRETARIO', funcao: 'SECRETARIO', nome: 'Secretário do Conselho' } });
    const ocupacao = await prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgao, cargo_id: cargo.id,
      pessoa_id: institucional.id, inicio: dia, termino_previsto: new Date('2031-01-09') } });
    for (const acao of ['VINCULOS_DOCUMENTAIS_CONSULTAR', 'VINCULOS_DOCUMENTAIS_REGISTRAR'] as const)
      await prisma.atribuicao_servico.create({ data: { igreja_id: igreja, usuario_id: conta.id, pessoa_id: institucional.id,
        geracao_vinculo: conta.geracao_vinculo, acao, inicio: dia } });
    const caminho = '/secretaria/atas-legadas';
    const dadosReuniao = {
      ...await planejamento(conselho),
      restrito: false,
      modalidade: 'ORDINARIA',
      data,
      local: 'Templo',
      pauta: 'Deliberação do Conselho',
      competencia: 'Conselho',
      universo_informado: 1,
      quorum_minimo: 1,
      quorum_conferido: true,
      fundamento_quorum: 'Conferido',
      resultado: '',
      participantes: [{ pessoa_id: pessoa, presente: true, papeis: ['SECRETARIO'] }],
    };
    await http('post', '/secretaria/reunioes')
      .send({ contexto_id: assembleia, idempotencia: randomUUID(), dados: dadosReuniao })
      .expect(400);
    const reuniao = await http('post', '/secretaria/reunioes')
      .send({ contexto_id: conselho, idempotencia: randomUUID(), dados: dadosReuniao })
      .expect(201);
    expect(await prisma.reuniao.findUnique({ where: { id: reuniao.body.id } })).toMatchObject({
      contexto_id: conselho, modalidade: 'ORDINARIA', dados: { modalidade: 'ORDINARIA' },
    });
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
      reuniao_id: reuniao.body.id,
      reuniao: { data, local: 'Templo', modalidade: 'ORDINARIA', inicio: null, fim: null, pauta: dadosReuniao.pauta },
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
      .send({ ...entrada, contexto_id: assembleia, reuniao_id: null })
      .expect(400);
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
          reuniao_id: reuniao.body.id,
          fonte_congelada: { legado: { reuniao: { local: 'Templo', modalidade: 'ORDINARIA' }, sha256: sha256(bytes) } },
          arrolados: [{ pessoa_id: pessoa, papeis: ['SECRETARIO'] }],
          resolucoes: [{ assunto: 'Admissão', proponentes: [{ arrolado: { pessoa_id: pessoa } }] }],
        },
      ],
    });
    const versao = detalhe.versoes[0].id;
    const selecao = '/oficiais/indicacoes/selecao-atas';
    const filtros = { tipo: 'CONSELHO', assunto: 'histórica', de: data, ate: data, contexto: conselho,
      pauta: 'liberação', arrolado: 'de teste', pagina: '0' };
    const opcoes = (await http('get', selecao).query(filtros).expect(200)).body;
    expect(opcoes.itens).toEqual([expect.objectContaining({ versao_id: versao, numero_formatado: entrada.numero_original,
      pauta: dadosReuniao.pauta, arrolados: ['Membro de teste'],
      resolucoes: [{ assunto: 'Admissão', texto: 'Receber membro conforme o registro.', resultado: 'APROVADA' }] })]);
    expect(opcoes.itens[0]).not.toHaveProperty('conteudo');
    for (const filtro of [{ tipo: 'ASSEMBLEIA' }, { arrolado: 'ausente' }, { pauta: 'ausente' }, { de: '2025-01-01', ate: '2025-12-31' }]) {
      expect((await http('get', selecao).query({ ...filtros, ...filtro }).expect(200)).body.itens).toEqual([]);
    }
    await http('get', selecao).query({ ...filtros, ate: '2020-01-01' }).expect(400);
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

    const referenciaMandato = ref('MANDATO', mandato, 'POSSE');
    const anteriorMandato = (await http('get', referenciaMandato).expect(200)).body.itens[0]?.id ?? null;
    const refMandato = (await http('post', referenciaMandato).send(ligacao({ documento: id, versao }, anteriorMandato)).expect(201)).body.id;

    const edicao = { idempotencia: randomUUID(), revisao: (await http('get', documento)).body.revisao,
      assunto: 'Ata revisada', numero_original: entrada.numero_original, data_documento: data,
      reuniao_id: reuniao.body.id, reuniao: { ...entrada.reuniao, local: 'Salão', pauta: 'Pauta corrigida' },
      teor: 'Transcrição corrigida.', arrolados: [...entrada.arrolados, { pessoa_id: membro, papeis: ['PRESENTE'] }],
      resolucoes: [{ ...entrada.resolucoes[0], assunto: 'Admissão revisada', proponentes_pessoas_ids: [membro] }],
    };
    const editar = (ator: string, valores = {}) => http('patch', caminho + '/' + id, ator).send({ ...edicao, ...valores });
    await editar('gestor').expect(403);
    await editar('auditor').expect(403);
    await editar('secretarioOutra').expect(404);
    await http('patch', caminho + '/' + ataRestrita.documento, 'secretario').send(edicao).expect(404);
    await http('patch', caminho + '/' + ataConselho.documento, 'secretariaInstitucional')
      .send({ ...edicao, revisao: (await http('get', '/secretaria/documentos/' + ataConselho.documento, 'secretariaInstitucional')).body.revisao }).expect(400);
    await editar('secretariaInstitucional', { pdf: entrada.pdf }).expect(400);
    await editar('secretariaInstitucional', { resolucoes: [{ ...edicao.resolucoes[0], proponentes_pessoas_ids: [randomUUID()] }] }).expect(400);
    // A consulta e a decisão são obrigatórias quando há atos vinculados.
    await editar('secretariaInstitucional').expect(409);
    let modal = (await http('get', documento + '/atos-para-reatribuir', 'secretariaInstitucional').expect(200)).body;
    expect(modal).toHaveLength(2);
    expect(modal.find(a => a.grupo === 'MEMBRESIA')).toMatchObject({ alvo_id: evento, pode_reatribuir: true });
    await http('get', documento + '/atos-para-reatribuir', 'secretarioOutra').expect(404);
    await editar('secretariaInstitucional', { reatribuicao_atos: { vistas: [randomUUID()], selecionadas: [] } }).expect(409);
    // Um vínculo mudado enquanto o modal está aberto invalida a decisão inteira.
    const membroAntes = modal.find(a => a.grupo === 'MEMBRESIA').referencia_id;
    await http('post', referenciaLegada).send(ligacao({ documento: id, versao }, membroAntes)).expect(201);
    await editar('secretariaInstitucional', { reatribuicao_atos: { vistas: modal.map(a => a.referencia_id), selecionadas: [membroAntes] } }).expect(409);
    expect((await http('get', documento).expect(200)).body.versao_atual).toBe(1);
    modal = (await http('get', documento + '/atos-para-reatribuir', 'secretariaInstitucional').expect(200)).body;
    const decisao = { reatribuicao_atos: { vistas: modal.map(a => a.referencia_id), selecionadas: [modal.find(a => a.grupo === 'MEMBRESIA').referencia_id] } };
    const salva = (await editar('secretariaInstitucional', decisao).expect(200)).body;
    expect((await editar('secretariaInstitucional', decisao).expect(200)).body).toEqual(salva);
    await editar('secretariaInstitucional', { idempotencia: randomUUID() }).expect(409);
    const corrigida = (await http('get', documento, 'secretariaInstitucional').expect(200)).body;
    expect(corrigida.versao_atual).toBe(2);
    expect(corrigida.versoes[0]).toMatchObject({ id: versao, conteudo: { teor: entrada.teor } });
    expect(corrigida.versoes[1]).toMatchObject({
      retifica_versao_id: versao, numero_original: entrada.numero_original, assunto: edicao.assunto,
      conteudo: { teor: edicao.teor }, anexos: [{ arquivo_id }], livro_id: livro, folhas_legadas: '2–3',
      fonte_congelada: { legado: { sha256: sha256(bytes), reuniao: { pauta: edicao.reuniao.pauta } } },
      resolucoes: [{ assunto: 'Admissão revisada', proponentes: [{ arrolado: { pessoa_id: membro } }] }],
    });
    expect(corrigida.versoes[1].arrolados).toHaveLength(2);
    expect((await http('get', '/secretaria/reunioes/' + reuniao.body.id, 'secretariaInstitucional').expect(200)).body.dados)
      .toMatchObject({ local: 'Salão', pauta: 'Pauta corrigida' });
    expect((await http('get', '/secretaria/livros/' + livro).expect(200)).body.atas_legadas).toHaveLength(1);
    expect((await http('get', referenciaMandato).expect(200)).body.itens[0]).toMatchObject({ id: refMandato, versao_id: versao, situacao: 'SUPERADA' });
    const transferida = (await http('get', referenciaLegada).expect(200)).body;
    expect(transferida.itens[0].versao_id).toBe(corrigida.versoes[1].id);
    expect(transferida.itens[1].versao_id).toBe(versao);
    expect(transferida.itens[1].situacao).toBe('SUPERADA');
    const novaLista = (await http('get', documento + '/atos-para-reatribuir', 'secretariaInstitucional').expect(200)).body;
    // NÃO cria a versão, mas mantém o ato na referência anterior.
    await editar('secretariaInstitucional', { revisao: salva.revisao, numero_original: '005', idempotencia: randomUUID(),
      reatribuicao_atos: { vistas: novaLista.map(a => a.referencia_id), selecionadas: [] } }).expect(200);
    const mantida = (await http('get', referenciaLegada).expect(200)).body;
    expect(mantida.itens[0].id).toBe(transferida.itens[0].id);
    expect(mantida.situacao).toBe('SUPERADA');

    const contextos = (await http('get', '/secretaria/contextos', 'secretariaInstitucional').expect(200)).body;
    expect(contextos.find(c => c.id === conselho).pode_editar_ata_legada).toBe(true);
    expect(contextos.find(c => c.id === assembleia).pode_editar_ata_legada).toBe(true);
    expect(contextos.find(c => c.id === junta)?.pode_editar_ata_legada ?? false).toBe(false);
    const listaInstitucional = (await http('get', documento + '/atos-para-reatribuir', 'secretariaInstitucional').expect(200)).body;
    const pedidoInstitucional = { revisao: (await http('get', documento).expect(200)).body.revisao, idempotencia: randomUUID(),
      reatribuicao_atos: { vistas: listaInstitucional.map(a => a.referencia_id), selecionadas: listaInstitucional.map(a => a.referencia_id) } };
    await editar('secretariaInstitucional', pedidoInstitucional).expect(200);
    await editar('secretariaInstitucional', pedidoInstitucional).expect(200);
    await prisma.ocupacao_cargo.update({ where: { id: ocupacao.id }, data: { fim: new Date('2026-01-11'), fim_ordem: 1 } });
    const semCargo = (await http('get', '/secretaria/contextos', 'secretariaInstitucional').expect(200)).body;
    expect(semCargo.find(c => c.id === conselho)?.pode_editar_ata_legada ?? false).toBe(false);
    await editar('secretariaInstitucional', pedidoInstitucional).expect(r => expect([403, 404]).toContain(r.status));

  });
});
