import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { PrismaService } from '../src/prisma/prisma.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const data = (dia: string) => new Date(dia + 'T00:00:00Z');
const hoje = new Date().toISOString().slice(0, 10);
const inicio = '2020-01-01';

integration('Sociedades e ministérios', () => {
  let app: INestApplication, db: PrismaService;
  let igreja: string, presidente: string, secretario: string, presidencia: string, pastor: string;
  let outraIgreja: string, secretariaExterna: string;
  const sessao = new Map<string, string>();

  function chamada(usuario: string, verbo: 'get' | 'post' | 'put', rota: string) {
    return request(app.getHttpServer())[verbo](rota).set('Cookie', sessao.get(usuario)!)
      .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  }

  function ato(id: string, dados: object, usuario = presidente) {
    return chamada(usuario, 'post', '/orgaos/institucional/' + id + '/atos')
      .send({ evidencia: 'Registro de ensaio', idempotencia: randomUUID(), ...dados });
  }

  async function pessoa(nome: string, nascimento: Date, sexo: 'MASCULINO' | 'FEMININO' = 'FEMININO', rol: 'COMUNGANTES' | 'NAO_COMUNGANTES' = 'COMUNGANTES') {
    const p = await db.pessoas.create({ data: { igreja_id: igreja, nome_completo: nome, sexo, data_nascimento: nascimento } });
    const data_evento = new Date(Math.max(nascimento.getTime(), data(inicio).getTime()));
    await db.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: p.id, data_evento, tipo_evento: 'ADMISSAO', rol,
      motivacao_evento: rol === 'COMUNGANTES' ? 'PROFISSAO_DE_FE' : 'BATISMO_NA_INFANCIA' } });
    return p.id;
  }

  async function login(igreja_id: string, perfil: 'COMUM', pessoa_id?: string, conta_atuacao = false) {
    const u = await db.usuarios.create({ data: { igreja_id, perfil, pessoa_id, conta_atuacao,
      nome_usuario: randomUUID(), email_login: randomUUID() + '@example.invalid', senha_hash: 'inutilizavel' } });
    sessao.set(u.id, 'provisao_session=' + await app.get(SessionService).create(u.id, igreja_id, 0));
    return u.id;
  }

  const orgao = (tipo_padrao: string) => db.orgao_interno.findFirstOrThrow({
    where: { igreja_id: igreja, tipo_padrao }, include: { contexto_secretaria: true, cargos: true },
  });
  const ativacao = { tipo: 'ATIVACAO_SOCIEDADE', fonte: 'GTSI 2022', idempotencia: randomUUID() };

  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public')
      throw new Error('Exige banco descartável E00.');
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.listen(0, '127.0.0.1');
    db = app.get(PrismaService);
    igreja = (await db.igreja.create({ data: { nome: 'Igreja do ensaio de sociedades', mfa_obrigatorio: false } })).id;
    outraIgreja = (await db.igreja.create({ data: { nome: 'Outra igreja de ensaio', mfa_obrigatorio: false } })).id;
    await db.$executeRaw`SELECT instalar_estrutura_institucional(${igreja})`;
    pastor = await pessoa('Pastor do ensaio', data('1980-06-01'), 'MASCULINO');
    presidente = await login(igreja, 'COMUM', pastor, true);
    secretario = await login(igreja, 'COMUM');
    secretariaExterna = await login(outraIgreja, 'COMUM');
    const oficial = await db.oficial.create({ data: { pessoa_id: pastor, igreja_id: igreja, tipo: 'PRESBITERO_DOCENTE' } });
    await db.vinculo_pastoral.create({ data: { oficial_id: oficial.id, igreja_id: igreja, modalidade: 'Pastor',
      concilio: 'Presbitério', ato: 'Posse', evidencia: 'Registro', data_inicio: data(inicio), exercicio_institucional: true } });
    await db.evento_oficial.create({ data: { oficial_id: oficial.id, igreja_id: igreja, tipo: 'ORDENACAO',
      data_efeito: data(inicio), ordem: 1, autoridade: 'Presbitério', evidencia: 'Registro' } });
    presidencia = (await db.presidencia_conselho.create({ data: { igreja_id: igreja, oficial_id: oficial.id, inicio: data(inicio),
      registrado_por: secretario, evidencia: 'Posse' } })).id;
  });

  afterAll(async () => { await app?.close(); });

  it('exige a presidência conferida e preserva contexto, adesão e diretoria da SAF', async () => {
    const saf = await orgao('SAF');
    await ato(saf.id, ativacao, secretario).expect(403);
    await ato(saf.id, ativacao).expect(403);
    await db.evento_autorizacao.create({ data: { igreja_id: igreja, pessoa_id: pastor, operador_id: secretario,
      recurso_id: presidencia, acao: 'PRESIDENCIA_CONFERIDA', dados: {}, fundamento: 'Ato de conferência' } });
    const organizacao = { ...ativacao, data_organizacao: '2022-02-01' };
    const [r, repetido] = await Promise.all([ato(saf.id, organizacao).expect(201), ato(saf.id, organizacao).expect(201)]);
    expect(repetido.body).toEqual(r.body);
    const presidenteSaf = await pessoa('Presidente da SAF', data('1990-09-02'));
    const contaSaf = await login(igreja, 'COMUM', presidenteSaf, true);
    await ato(saf.id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: presidenteSaf, desde: '2022-03-01' }).expect(201);
    await ato(saf.id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: pastor }).expect(400);
    const cargo = saf.cargos.find(c => c.codigo === 'PRESIDENTE')!;
    const eleicao = { tipo: 'PROVIMENTO', pessoa_id: presidenteSaf, cargo_id: cargo.id, data_eleicao: hoje, termino_previsto: hoje,
      posse: 'Termo de posse', aprovacao_conselho: 'Ata do Conselho', presente_na_eleicao: true };
    await ato(saf.id, { ...eleicao, frequencia_plenarias: 49 }).expect(400);
    await ato(saf.id, { ...eleicao, frequencia_plenarias: 50 }).expect(201);
    const conselheiro = (await orgao('SAF')).cargos.find(c => c.codigo === 'CONSELHEIRO')!;
    await ato(saf.id, { tipo: 'PROVIMENTO', pessoa_id: pastor, cargo_id: conselheiro.id }).expect(201);
    const ficha = (await chamada(contaSaf, 'get', '/orgaos/' + saf.id + '?data=' + hoje).expect(200)).body;
    expect(ficha.contexto_id).toBe(saf.contexto_secretaria!.id);
    expect(ficha.cargos_na_data.find(c => c.id === cargo.id).titulares[0].id).toBe(presidenteSaf);
    expect(ficha.participacoes[0]).toMatchObject({ pessoa: { id: presidenteSaf }, direito_voto: true });
    await chamada(contaSaf, 'get', '/secretaria/contextos/' + ficha.contexto_id + '/resumo').expect(200);
    const pessoas = await chamada(contaSaf, 'get', '/secretaria/contextos/' + ficha.contexto_id + '/pessoas').expect(200);
    expect(pessoas.body.map(p => p.id).sort()).toEqual([pastor, presidenteSaf].sort());
    const tesoureira = await pessoa('Tesoureira da SAF', data('1985-01-01'));
    const socia = await pessoa('Sócia da SAF sem cargo', data('1985-01-01'));
    const contaTesoureira = await login(igreja, 'COMUM', tesoureira);
    const contaSocia = await login(igreja, 'COMUM', socia);
    for (const id of [tesoureira, socia])
      await ato(saf.id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: id, desde: '2022-04-01' }).expect(201);
    const tesouraria = saf.cargos.find(c => c.codigo === 'TESOUREIRO')!;
    await ato(saf.id, { ...eleicao, pessoa_id: tesoureira, cargo_id: tesouraria.id, frequencia_plenarias: 100 }).expect(201);
    const ataSaf = await db.documento.create({ data: { igreja_id: igreja, contexto_id: ficha.contexto_id, tipo: 'ATA', perfil: 'GERAL' } });
    const rotaAta = '/secretaria/documentos/' + ataSaf.id;
    const restringir = { restrito: true, revisao: ataSaf.revisao, idempotencia: randomUUID() };
    await chamada(contaSocia, 'get', rotaAta).expect(200);
    await chamada(contaSaf, 'post', rotaAta + '/sigilo').send(restringir).expect(201);
    await chamada(contaTesoureira, 'get', rotaAta).expect(200);
    await chamada(presidente, 'get', rotaAta).expect(200);
    await chamada(contaSocia, 'get', rotaAta).expect(404);
    const listaSocia = await chamada(contaSocia, 'get', '/secretaria/documentos?contexto=' + ficha.contexto_id).expect(200);
    expect(listaSocia.body.map(d => d.id)).not.toContain(ataSaf.id);
    await chamada(contaTesoureira, 'post', rotaAta + '/sigilo')
      .send({ restrito: false, revisao: ataSaf.revisao + 1, idempotencia: randomUUID() }).expect(403);
    const ocupacaoTesoureira = await db.ocupacao_cargo.findFirstOrThrow({ where: { igreja_id: igreja, cargo_id: tesouraria.id, pessoa_id: tesoureira } });
    await ato(saf.id, { tipo: 'ENCERRAMENTO_CARGO', ocupacao_id: ocupacaoTesoureira.id, motivo: 'Término do exercício' }).expect(201);
    await chamada(contaTesoureira, 'get', rotaAta).expect(404);
    await chamada(secretariaExterna, 'get', '/orgaos/' + saf.id + '?data=' + hoje).expect(404);
    await ato(saf.id, { tipo: 'DESATIVACAO', motivo: 'Desativação de ensaio' }).expect(201);
    await ato(saf.id, { tipo: 'ATIVACAO_SOCIEDADE', fonte: 'GTSI 2022' }).expect(201);
    const reativada = (await chamada(presidente, 'get', '/orgaos/' + saf.id + '?data=' + hoje).expect(200)).body;
    expect(reativada).toMatchObject({ vigente_na_data: true, contexto_id: ficha.contexto_id });
    expect(reativada.participacoes.find(p => p.pessoa.id === presidenteSaf)).toMatchObject({ pessoa: { id: presidenteSaf }, fim: data(hoje).toISOString(), direito_voto: false });
  });

  it('permite ao secretário da Junta restringir e aos diáconos com mandato vigente ler a ata', async () => {
    const junta = await orgao('JUNTA');
    const contexto = junta.contexto_secretaria!.id;
    const versao = await db.versao_orgao.findFirstOrThrow({ where: { igreja_id: igreja, orgao_id: junta.id } });
    async function diacono(nome: string, termino_previsto: Date) {
      const pessoaId = await pessoa(nome, data('1980-02-01'), 'MASCULINO');
      const usuario = await login(igreja, 'COMUM', pessoaId);
      const oficial = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoaId, tipo: 'DIACONO' } });
      await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, tipo: 'ORDENACAO',
        data_efeito: data(inicio), ordem: 1, autoridade: 'Conselho', evidencia: 'Ata de ordenação' } });
      await db.mandato_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, orgao_id: junta.id,
        versao_orgao_id: versao.id, chave_registro: randomUUID(), hash_registro: 'a'.repeat(64),
        data_eleicao: data(inicio), data_posse: data(inicio), termino_previsto,
        autoridade: 'Assembleia', evidencia: 'Ata', avaliacao_eleicao: {} } });
      return { pessoaId, usuario };
    }
    const secretarioJunta = await diacono('Secretário da Junta', data(hoje));
    const integrante = await diacono('Integrante da Junta', data(hoje));
    const exIntegrante = await diacono('Diácono fora do mandato', new Date(data(hoje).getTime() - 86400000));
    const cargoSecretario = junta.cargos.find(c => c.funcao === 'SECRETARIO')!;
    await db.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: junta.id, cargo_id: cargoSecretario.id,
      pessoa_id: secretarioJunta.pessoaId, inicio: data(inicio), termino_previsto: data(hoje) } });
    const ata = await db.documento.create({ data: { igreja_id: igreja, contexto_id: contexto, tipo: 'ATA', perfil: 'GERAL' } });
    const rota = '/secretaria/documentos/' + ata.id;
    const comando = { restrito: true, revisao: ata.revisao, idempotencia: randomUUID() };
    await chamada(integrante.usuario, 'post', rota + '/sigilo').send(comando).expect(403);
    await chamada(secretarioJunta.usuario, 'post', rota + '/sigilo').send(comando).expect(201);
    await chamada(integrante.usuario, 'get', rota).expect(200);
    await chamada(exIntegrante.usuario, 'get', rota).expect(404);
    await chamada(secretario, 'get', rota).expect(404);
    await chamada(secretariaExterna, 'get', rota).expect(404);
    await chamada(presidente, 'get', rota).expect(200);
  });

  it('compara, aprova e programa versão com vigência futura e base conferida', async () => {
    const conselho = await orgao('CONSELHO');
    const rota = '/orgaos/' + conselho.id + '/configuracao';
    const futuro = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10);
    const regra = { inicio: futuro, fonte: 'Regimento aprovado do ensaio', autoridade: 'Conselho',
      evidencia: 'Ata sintética, item 12', prazo_maximo_meses: 36, posse_integrante: 'ASSEMBLEIA_GERAL' };
    await chamada(secretario, 'put', rota + '/proposta').send(regra).expect(403);
    await chamada(secretariaExterna, 'get', rota).expect(403);
    await chamada(presidente, 'put', rota + '/proposta').send({ ...regra, inicio: hoje }).expect(400);
    const { body: proposta } = await chamada(presidente, 'put', rota + '/proposta').send(regra).expect(200);
    expect(proposta.alteracoes).toContainEqual({ campo: 'Prazo máximo dos cargos em meses', antes: 60, depois: 36 });
    expect(await db.versao_orgao.count({ where: { orgao_id: conselho.id } })).toBe(1);
    const { body: revisada } = await chamada(presidente, 'put', rota + '/proposta').send({ ...regra, prazo_maximo_meses: 30 }).expect(200);
    await chamada(presidente, 'post', rota + '/adotar').send({ id: proposta.id, previa: proposta.previa }).expect(409);
    const confirmar = () => chamada(presidente, 'post', rota + '/adotar').send({ id: revisada.id, previa: revisada.previa }).expect(201);
    const { body: publicada } = await confirmar();
    expect((await confirmar()).body).toEqual(publicada);
    const [anterior, nova] = await db.versao_orgao.findMany({ where: { orgao_id: conselho.id }, orderBy: { numero: 'asc' } });
    expect(anterior.fim).toEqual(data(futuro));
    expect(nova.inicio).toEqual(data(futuro));
    expect(nova.configuracao).toMatchObject({ cargo_prazo_maximo_meses: 30, atos: { posse_integrante: 'ASSEMBLEIA_GERAL' } });
    expect((await chamada(presidente, 'get', '/orgaos/' + conselho.id + '?data=' + hoje).expect(200)).body.versao.numero).toBe(1);
    expect((await chamada(presidente, 'get', '/orgaos/' + conselho.id + '?data=' + futuro).expect(200)).body.versao.numero).toBe(2);
    expect(await db.ato_orgao.count({ where: { orgao_id: conselho.id, tipo: 'ADOTAR_CONFIGURACAO' } })).toBe(1);
  });

  it('sinaliza o aniversário UPA/UMP, protege o nominal e só admite depois da saída', async () => {
    const upa = await orgao('UPA'), ump = await orgao('UMP');
    await ato(upa.id, { ...ativacao, idempotencia: randomUUID(), data_organizacao: '2022-02-01' }).expect(201);
    await ato(ump.id, { ...ativacao, idempotencia: randomUUID(), idade_transicao: 18 }).expect(400);
    await ato(ump.id, { ...ativacao, idempotencia: randomUUID(), idade_transicao: 19 }).expect(201);
    const nascimento = data(hoje);
    nascimento.setUTCFullYear(nascimento.getUTCFullYear() - 19);
    const jovem = await pessoa('Jovem do ensaio etário', nascimento);
    await ato(upa.id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: jovem }).expect(400);
    const ontem = new Date(data(hoje).getTime() - 86400000).toISOString().slice(0, 10);
    const entrada = await ato(upa.id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: jovem, desde: ontem }).expect(201);
    const rota = '/orgaos/' + upa.id;
    const hojeFicha = (await chamada(presidente, 'get', rota + '?data=' + hoje).expect(200)).body;
    expect(hojeFicha.participacoes[0]).toMatchObject({ revisao_faixa: { situacao: 'REVISAR', destino: 'UMP', data_limite: hoje }, direito_voto: false });
    const anonima = (await chamada(secretario, 'get', rota + '?data=' + hoje).expect(200)).body;
    expect(anonima).toMatchObject({ participacoes: [], consulta_nominal: false, contexto_id: null });
    await chamada(secretario, 'get', rota + '/atos/' + entrada.body.ato_id).expect(404);
    await chamada(secretario, 'get', '/secretaria/contextos/' + upa.contexto_secretaria!.id + '/resumo').expect(404);
    const orientador = (await orgao('UPA')).cargos.find(c => c.codigo === 'ORIENTADOR')!;
    const pessoaOrientador = await pessoa('Orientador de teste', data('1988-01-01'), 'MASCULINO');
    const contaOrientador = await login(igreja, 'COMUM', pessoaOrientador, true);
    await ato(upa.id, { tipo: 'PROVIMENTO', pessoa_id: pessoaOrientador, cargo_id: orientador.id }).expect(201);
    expect((await chamada(contaOrientador, 'get', rota + '?data=' + hoje).expect(200)).body.consulta_nominal).toBe(true);
    await ato(ump.id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: jovem }).expect(409);
    await ato(upa.id, { tipo: 'PARTICIPACAO_SAIDA', pessoa_id: jovem }).expect(201);
    await ato(ump.id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: jovem }).expect(201);
    const fichaUmp = (await chamada(presidente, 'get', '/orgaos/' + ump.id + '?data=' + hoje).expect(200)).body;
    expect(fichaUmp.participacoes[0]).toMatchObject({ pessoa: { id: jovem }, direito_voto: true });
  });

  it('institui um ministério, designa liderança e fecha a escrita após desativação', async () => {
    const entrada = { nome: 'Ministério de acolhimento', finalidade: 'Acolher visitantes', constituicao: 'DESIGNACAO',
      cargos: ['Coordenador', 'Apoio'], participacao: 'COMUNGANTES', evidencia: 'Ato de instituição', idempotencia: randomUUID() };
    await chamada(secretario, 'post', '/orgaos/institucional/ministerios').send(entrada).expect(403);
    const criado = await chamada(presidente, 'post', '/orgaos/institucional/ministerios').send(entrada).expect(201);
    const id = criado.body.id as string;
    const ministerio = await db.orgao_interno.findUniqueOrThrow({ where: { id }, include: { contexto_secretaria: true, cargos: true } });
    const cargo = ministerio.cargos.find(c => c.nome === 'Coordenador')!;
    const lider = await pessoa('Coordenador de acolhimento', data('1990-01-01'));
    const contaLider = await login(igreja, 'COMUM', lider, true);
    const naoComungante = await pessoa('Visitante do cadastro', data('2000-01-01'), 'FEMININO', 'NAO_COMUNGANTES');
    await ato(id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: naoComungante }).expect(400);
    await ato(id, { tipo: 'PROVIMENTO', pessoa_id: lider, cargo_id: cargo.id }).expect(201);
    const contexto = ministerio.contexto_secretaria!.id;
    const documento = await db.documento.create({ data: { igreja_id: igreja, contexto_id: contexto, tipo: 'ATA', perfil: 'GERAL' } });
    await chamada(contaLider, 'get', '/secretaria/documentos?contexto=' + contexto).expect(200);
    await ato(id, { tipo: 'DESATIVACAO', motivo: 'Encerramento do trabalho' }).expect(201);
    await ato(id, { tipo: 'PROVIMENTO', pessoa_id: lider, cargo_id: cargo.id }).expect(409);
    const acervo = await chamada(presidente, 'get', '/secretaria/documentos?contexto=' + contexto).expect(200);
    expect(acervo.body).toEqual([expect.objectContaining({ id: documento.id })]);
    expect(await db.ocupacao_cargo.findFirst({ where: { orgao_id: id, pessoa_id: lider } })).toMatchObject({ fim: data(hoje) });
    expect((await chamada(presidente, 'get', '/secretaria/contextos').expect(200)).body.find(c => c.id === contexto)).toMatchObject({ pode_preparar: false });
    await chamada(secretario, 'post', '/secretaria/reunioes').send({ contexto_id: contexto, idempotencia: randomUUID(),
      dados: { data: hoje, modalidade: 'ORDINARIA', local: 'Igreja', pauta: 'Tentativa', participantes: [],
        universo_informado: 0, quorum_minimo: 0, quorum_conferido: false, resultado: '', restrito: false } }).expect(403);
  });

  it('registra eleição de ministério com participação, prazo e fundamento de posse', async () => {
    const criado = await chamada(presidente, 'post', '/orgaos/institucional/ministerios').send({
      nome: 'Ministério com eleição', finalidade: 'Visitação', constituicao: 'ELEICAO', cargos: ['Coordenação'],
      prazo_maximo_meses: 12, participacao: 'MEMBROS', evidencia: 'Ato de instituição', idempotencia: randomUUID(),
    }).expect(201);
    const id = criado.body.id as string;
    const cargo = await db.cargo_orgao.findFirstOrThrow({ where: { igreja_id: igreja, orgao_id: id } });
    const lider = await pessoa('Pessoa eleita', data('1995-02-01'));
    const eleicao = { tipo: 'PROVIMENTO', cargo_id: cargo.id, pessoa_id: lider, data_eleicao: hoje, termino_previsto: hoje, posse: 'Ato de posse' };
    await ato(id, eleicao).expect(400);
    await ato(id, { tipo: 'PARTICIPACAO_INCLUSAO', pessoa_id: lider }).expect(201);
    await ato(id, { ...eleicao, termino_previsto: '2099-01-01' }).expect(400);
    const r = await ato(id, eleicao).expect(201);
    expect((await db.ato_orgao.findUniqueOrThrow({ where: { id: r.body.ato_id } })).detalhes)
      .toMatchObject({ modo: 'ELEICAO', data_eleicao: hoje, posse: 'Ato de posse' });
  });
});
