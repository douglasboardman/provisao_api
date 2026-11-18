import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PDFDocument } from 'pdf-lib';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
import { PrivateStorageService } from '../src/private-storage/private-storage.service';
import { ExpedicaoWorkerService } from '../src/secretaria/expedicao-worker.service';
import { RascunhosService } from '../src/secretaria/rascunhos.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
integration('E06: livros e paginação no PostgreSQL', () => {
  let app: INestApplication, prisma: PrismaService;
  const igreja = randomUUID(),
    outraIgreja = randomUUID(),
    pessoa = randomUUID();
  const atores = { secretario: randomUUID(), gestor: randomUUID(), admin: randomUUID(), outra: randomUUID() };
  const cookies: Partial<Record<keyof typeof atores, string>> = {};
  const data = '2026-01-12';
  let contexto: string,
    outroTitular: string,
    abertura: string,
    encerramento: string,
    ata: string,
    exame: string,
    reuniao: string;
  let livro: string;
  const post = (path: string, ator: keyof typeof atores = 'secretario') =>
    request(app.getHttpServer())
      .post('/secretaria/' + path)
      .set('Cookie', cookies[ator]!)
      .set('Origin', 'http://localhost:3001')
      .set('X-Provisao-Request', '1');
  const get = (path: string, ator: keyof typeof atores = 'secretario') =>
    request(app.getHttpServer())
      .get('/secretaria/' + path)
      .set('Cookie', cookies[ator]!);
  const cmd = (revisao: number) => ({
    revisao,
    autoridade: 'Mesa competente',
    evidencia: 'Ato sintético conferido',
    idempotencia: randomUUID(),
  });
  const entradaLivro = (numero: number) => ({
    contexto_id: contexto,
    numero,
    serie: 'ATA_PADRAO',
    modalidade: 'PARA_ENCADERNACAO',
    perfil: 'LOCAL_V1',
    capacidade_folhas: 5,
    faces_por_folha: 1,
    reserva_exame: 1,
    fonte_normativa: 'Regimento sintético vigente desde 2026-01-01',
    restrito: false,
    idempotencia: randomUUID(),
  });
  const entradaDoc = (modelo: string, livroId: string | null, teor = 'Conteúdo sintético de homologação.') => ({
    contexto_id: contexto,
    restrito: false,
    idempotencia: randomUUID(),
    versao: {
      modelo_versao_id: modelo,
      livro_id: livroId,
      reuniao_id: modelo === ata ? reuniao : null,
      assunto: 'Secretaria E06',
      data_documento: data,
      conteudo: {
        teor,
        campos: { NUMERO_LIVRO: '999' },
        anexos: [],
        arrolados: [
          {
            pessoa_id: pessoa,
            papeis: ['PRESIDENTE', 'SECRETARIO'],
            assina: true,
            obrigatorio: true,
            responsavel: true,
            fundamento: 'Mesa competente',
          },
        ],
      },
    },
  });
  const ambiente = {
    FEATURE_SECRETARIA: process.env.FEATURE_SECRETARIA,
    FEATURE_SECRETARIA_LIVROS: process.env.FEATURE_SECRETARIA_LIVROS,
    FEATURE_SECRETARIA_ASSINATURAS: process.env.FEATURE_SECRETARIA_ASSINATURAS,
  };
  beforeAll(async () => {
    if (
      process.env.DATABASE_URL !==
      'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public'
    )
      throw new Error('Exige banco descartável E00.');
    process.env.FEATURE_SECRETARIA = 'true';
    process.env.FEATURE_SECRETARIA_ASSINATURAS = 'true';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    for (const id of [igreja, outraIgreja]) await prisma.igreja.create({ data: { id, nome: 'Igreja sintética E06' } });
    await prisma.pessoas.create({
      data: {
        id: pessoa,
        igreja_id: igreja,
        nome_completo: 'Responsável E06',
        sexo: 'FEMININO',
        data_nascimento: new Date('1982-01-01'),
      },
    });
    for (const [key, perfil] of [
      ['secretario', 'SECRETARIO'],
      ['gestor', 'GESTOR'],
      ['admin', 'ADMINISTRADOR'],
      ['outra', 'ADMINISTRADOR'],
    ] as const) {
      const id = atores[key],
        tenant = key === 'outra' ? outraIgreja : igreja;
      const usuario = await prisma.usuarios.create({
        data: {
          id,
          igreja_id: tenant,
          pessoa_id: key === 'gestor' ? pessoa : null,
          nome_usuario: key,
          email_login: id + '@example.invalid',
          senha_hash: 'inutilizavel',
          perfil,
          ativo: true,
        },
      });
      cookies[key] = 'provisao_session=' + (await app.get(SessionService).create(id, tenant, usuario.auth_version));
    }
    contexto = (
      await post('contextos', 'admin')
        .send({ tipo: 'ASSEMBLEIA_GERAL', nome: 'Assembleia', sigla: 'AG', idempotencia: randomUUID() })
        .expect(201)
    ).body.id;
    const orgao = await prisma.orgao_interno.create({
      data: {
        igreja_id: igreja,
        tipo: 'JUNTA',
        constituicao: 'OFICIAL',
        nome: 'Junta',
        finalidade: 'Teste sintético',
        data_criacao: new Date(data),
        criador_id: atores.admin,
        instituidor_id: pessoa,
        evidencia_instituicao: 'Ato sintético',
      },
    });
    outroTitular = (
      await post('contextos', 'admin')
        .send({ tipo: 'ORGAO', orgao_id: orgao.id, nome: 'Junta', sigla: 'JT', idempotencia: randomUUID() })
        .expect(201)
    ).body.id;
    await post('competencias', 'admin')
      .send({
        contexto_id: contexto,
        usuario_id: atores.gestor,
        inicio: '2020-01-01',
        pode_aprovar: true,
        pode_deliberar: true,
        pode_consultar_restritos: true,
        autoridade: 'Conselho',
        evidencia: 'Ato sintético',
        idempotencia: randomUUID(),
      })
      .expect(201);
    const modelo = async (tipo: 'ATA' | 'OUTRO', finalidade: string, registro_em_livro: string) =>
      (
        await post('modelos')
          .send({
            contexto_id: contexto,
            tipo,
            finalidade,
            nome: finalidade,
            idempotencia: randomUUID(),
            configuracao: {
              contexto: 'ASSEMBLEIA_GERAL',
              perfil: tipo === 'ATA' ? 'ATA_PADRAO' : 'TERMO',
              motivador: 'NAO_PERMITE',
              resolucoes: 'NAO_PERMITE',
              registro_livro: false,
              registro_em_livro,
              campos_obrigatorios: [],
              papeis_obrigatorios: ['PRESIDENTE'],
              cargos_obrigatorios: [],
            },
          })
          .expect(201)
      ).body.versao_id as string;
    abertura = await modelo('OUTRO', 'TERMO_ABERTURA', 'NAO_PERMITE');
    encerramento = await modelo('OUTRO', 'TERMO_ENCERRAMENTO', 'NAO_PERMITE');
    ata = await modelo('ATA', 'ATA_AGO', 'OBRIGATORIO');
    exame = await modelo('OUTRO', 'TERMO_EXAME', 'OPCIONAL');
    reuniao = (
      await post('reunioes')
        .send({
          contexto_id: contexto,
          idempotencia: randomUUID(),
          dados: {
            restrito: false,
            modalidade: 'AGO',
            data,
            local: 'Templo',
            pauta: 'Pauta sintética',
            competencia: 'Assembleia',
            universo_informado: 1,
            quorum_minimo: 1,
            quorum_conferido: true,
            fundamento_quorum: 'Conferido',
            resultado: 'Apreciada',
            participantes: [{ pessoa_id: pessoa, presente: true, papeis: ['PRESIDENTE', 'SECRETARIO'] }],
          },
        })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(ambiente)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (app) await app.close();
  });

  const detalheLivro = async () => (await get('livros/' + livro).expect(200)).body;
  const detalheDoc = async (id: string) => (await get('documentos/' + id).expect(200)).body;
  const acao = (acao: string, revisao: number) =>
    post(`livros/${livro}/acoes/${acao}`, 'gestor').send({ ...cmd(revisao), motivo: 'Fundamento registrado em ata' });
  async function preparar(entrada: ReturnType<typeof entradaDoc>) {
    const id = (await post('documentos').send(entrada).expect(201)).body.id as string;
    await post(`documentos/${id}/encaminhar`).send(cmd(1)).expect(201);
    const deliberar = !!entrada.versao.reuniao_id;
    if (deliberar)
      await post(`documentos/${id}/deliberar`, 'gestor')
        .send({ ...cmd(2), reuniao_id: reuniao, resultado: 'APROVADA', data })
        .expect(201);
    return { id, revisao: deliberar ? 3 : 2 };
  }
  async function processar(trabalho: string) {
    for (let i = 0; i < 50; i++) {
      const job = await prisma.trabalho_renderizacao.findUniqueOrThrow({ where: { id: trabalho } });
      if (job.estado === 'CONCLUIDO') return job;
      if (!(await app.get(RascunhosService).executarUm())) throw new Error('Trabalho não concluído: ' + job.estado);
    }
    throw new Error('Fila excedeu o limite do ensaio.');
  }
  const medir = async (d: { id: string; revisao: number }) =>
    processar((await post(`documentos/${d.id}/medicao-livro`).send({ revisao: d.revisao }).expect(201)).body.id);
  const aprovar = (d: { id: string; revisao: number }) =>
    post(`documentos/${d.id}/aprovar`, 'gestor').send({ ...cmd(d.revisao), modalidade: 'FISICA' });
  async function matriz(id: string) {
    const jobs = (await get(`documentos/${id}/artefatos`).expect(200)).body;
    return processar(jobs.find((item) => item.finalidade === 'MATRIZ_APROVADA').id);
  }
  async function expedirFisicamente(id: string) {
    const job = await matriz(id);
    const detalhe = await detalheDoc(id);
    const versao = detalhe.versoes.find((v) => v.id === job.versao_id);
    const url = `documentos/${id}/assinaturas`;
    const dados = { versao_id: versao.id, revisao: detalhe.revisao, idempotencia: randomUUID() };
    await post(`${url}/via`, 'gestor').send(dados).expect(201);
    const via = (await get(`${url}/${versao.id}/arquivos/via`, 'gestor').expect(200)).body as Buffer;
    const pdf = await PDFDocument.load(via);
    pdf.getPages().at(-1)!.drawText('Marca de conferência sintética', { x: 80, y: 38, size: 9 });
    const scan = Buffer.from(await pdf.save());
    await post(`${url}/fisica/conferir`, 'gestor')
      .field(
        'dados',
        JSON.stringify({
          ...dados,
          idempotencia: randomUUID(),
          evidencia: 'Original sintético conferido',
          via_sha256: createHash('sha256').update(via).digest('hex'),
          assinaturas: versao.arrolados
            .filter((a) => a.assina)
            .map((a) => ({
              arrolado_id: a.id,
              data,
              evidencia: 'Rubrica de teste',
            })),
        }),
      )
      .attach('file', scan, 'original-sintetico.pdf')
      .expect(201);
    expect((await detalheDoc(id)).estado).toBe('APROVADO');
    expect(await app.get(ExpedicaoWorkerService).executarUm()).toBe(true);
    expect((await detalheDoc(id)).estado).toBe('EXPEDIDO');
  }

  it('protege a funcionalidade e rejeita termo errado, outro titular e outra igreja', async () => {
    delete process.env.FEATURE_SECRETARIA_LIVROS;
    await get(`livros?contexto=${contexto}`).expect(404);
    process.env.FEATURE_SECRETARIA_LIVROS = 'true';
    const entrada = entradaLivro(1);
    const [criado, repetido] = await Promise.all([
      post('livros').send(entrada).expect(201),
      post('livros').send(entrada).expect(201),
    ]);
    expect(criado.body).toEqual(repetido.body);
    livro = criado.body.id;
    await post('livros')
      .send({ ...entrada, idempotencia: randomUUID() })
      .expect(409);
    await post('livros')
      .send({ ...entradaLivro(2), perfil: 'CONCILIO_IPB_2025', capacidade_folhas: 50 })
      .expect(400);
    await post('livros', 'admin').send(entradaLivro(2)).expect(403);
    await get(`livros/${livro}`, 'outra').expect(404);
    const outro = (
      await post('livros')
        .send({ ...entradaLivro(1), contexto_id: outroTitular })
        .expect(201)
    ).body.id;
    await post('documentos').send(entradaDoc(abertura, outro)).expect(400);
    await post('documentos').send(entradaDoc(ata, null)).expect(400);
    await post('documentos').send(entradaDoc(ata, livro)).expect(400);
    await post('documentos').send(entradaDoc(encerramento, livro)).expect(400);
  });

  it('controla espaço, concorrência, suspensão, encerramento, manifesto e originais', async () => {
    const termo = await preparar(entradaDoc(abertura, livro));
    await post('documentos').send(entradaDoc(abertura, livro)).expect(409);
    await aprovar(termo).expect(400);
    expect(await medir(termo)).toMatchObject({ paginas_medidas: 1, arquivo_id: null });
    await aprovar(termo).expect(201);
    expect(await detalheLivro()).toMatchObject({
      estado: 'EM_PREPARACAO',
      registros: [{ natureza: 'ABERTURA', estado: 'RESERVADO', posicao_inicio: 1, numero_visivel_inicio: null }],
    });
    expect((await detalheDoc(termo.id)).versoes[0].conteudo.campos.NUMERO_LIVRO).toBe('1');
    await expect(
      prisma.livro_atas.update({ where: { id: livro }, data: { estado: 'ABERTO', aberto_em: new Date() } }),
    ).rejects.toThrow();
    const aberturaPdf = await matriz(termo.id);
    const termoBytes = (await get(`documentos/${termo.id}/artefatos/${aberturaPdf.id}/arquivo`).expect(200)).body;
    expect(execFileSync('pdftotext', ['-layout', '-', '-'], { input: termoBytes, encoding: 'utf8' })).not.toMatch(
      /^\s+1\s*$/m,
    );
    await expedirFisicamente(termo.id);
    const a = await preparar(entradaDoc(ata, livro)),
      b = await preparar(entradaDoc(ata, livro));
    await medir(a);
    await medir(b);
    await Promise.all([aprovar(a).expect(201), aprovar(b).expect(201)]);
    const detalhe = await detalheLivro();
    expect(detalhe.registros.map((r) => [r.ordem, r.posicao_inicio, r.numero_visivel_inicio])).toEqual([
      [1, 1, null],
      [2, 2, 1],
      [3, 3, 2],
    ]);
    const longa = await preparar(
      entradaDoc(ata, livro, Array(200).fill('Pauta, relato e deliberações de uma ata extensa.').join('\n')),
    );
    expect((await medir(longa)).paginas_medidas).toBeGreaterThan(1);
    await aprovar(longa).expect(400);
    expect((await detalheDoc(longa.id)).estado).toBe('EM_EDICAO');
    expect(await prisma.registro_livro.count({ where: { livro_id: livro } })).toBe(3);
    const registro = detalhe.registros.find((r) => r.versao.documento_id === a.id);
    const pdf = await matriz(a.id);
    const bytes = (await get(`documentos/${a.id}/artefatos/${pdf.id}/arquivo`).expect(200)).body;
    expect(execFileSync('pdftotext', ['-layout', '-', '-'], { input: bytes, encoding: 'utf8' })).toMatch(
      new RegExp(`^\\s+${registro.numero_visivel_inicio}\\s*$`, 'm'),
    );
    await expect(
      prisma.registro_livro.update({ where: { id: registro.id }, data: { posicao_inicio: 4, posicao_fim: 4 } }),
    ).rejects.toThrow();
    await acao('preparar-encerramento', detalhe.revisao).expect(400);
    await acao('suspender', detalhe.revisao).expect(201);
    await post('documentos').send(entradaDoc(ata, livro)).expect(400);
    await expedirFisicamente(a.id);
    await post(`documentos/${b.id}/cancelar`, 'gestor').send(cmd(4)).expect(201);
    await acao('retomar', (await detalheLivro()).revisao).expect(201);

    const docExame = await preparar(entradaDoc(exame, livro));
    await medir(docExame);
    await aprovar(docExame).expect(201);
    await expedirFisicamente(docExame.id);
    expect((await detalheLivro()).registros.at(-1)).toMatchObject({ natureza: 'EXAME', posicao_inicio: 4 });
    await acao('preparar-encerramento', (await detalheLivro()).revisao).expect(201);
    const desistente = await preparar(entradaDoc(encerramento, livro));
    await acao('desistir-encerramento', (await detalheLivro()).revisao).expect(201);
    expect((await detalheDoc(desistente.id)).estado).toBe('CANCELADO');
    await acao('preparar-encerramento', (await detalheLivro()).revisao).expect(201);
    const termoFinal = await preparar(entradaDoc(encerramento, livro));
    expect((await detalheDoc(termoFinal.id)).versoes[0].conteudo.campos).toMatchObject({
      CAPACIDADE_FOLHAS: '5',
      FOLHAS_UTILIZADAS: '4',
      PAGINAS_UTILIZADAS: '4',
      TOTAL_ATAS: '1',
      SALDO_FOLHAS: '1',
      SALDO_FACES: '1',
    });
    await medir(termoFinal);
    await aprovar(termoFinal).expect(201);
    expect((await detalheLivro()).estado).toBe('EM_ENCERRAMENTO');
    await get(`livros/${livro}/arquivos/compilacao`).expect(404);
    await expedirFisicamente(termoFinal.id);
    const fechado = await detalheLivro();
    expect(fechado).toMatchObject({
      estado: 'ENCERRADO',
      capacidade_folhas: 5,
      totais: { paginas_utilizadas: 4, total_atas: 1 },
    });
    const manifesto = await get(`livros/${livro}/arquivos/manifesto`).expect(200);
    expect(createHash('sha256').update(manifesto.text).digest('hex')).toBe(fechado.manifesto_sha256);
    expect(manifesto.body.registros.map((r) => r.natureza)).toEqual([
      'ABERTURA',
      'ATA_ORIGINAL',
      'EXAME',
      'ENCERRAMENTO',
    ]);
    const compilacao = (await get(`livros/${livro}/arquivos/compilacao`).expect(200)).body;
    expect((await PDFDocument.load(compilacao)).getPageCount()).toBe(6);
    const inicial = fechado.registros[0];
    const original = (await get(`livros/${livro}/registros/${inicial.id}/arquivo`).expect(200)).body;
    expect(createHash('sha256').update(original).digest('hex')).toBe(inicial.arquivo.sha256);
    await get(`livros/${livro}/registros/${inicial.id}/arquivo`, 'outra').expect(404);
    await expect(
      prisma.livro_atas.update({ where: { id: livro }, data: { estado: 'ABERTO', encerrado_em: null } }),
    ).rejects.toThrow();
    const complemento = await preparar(entradaDoc(exame, null));
    await aprovar(complemento).expect(201);
    const versao = (await detalheDoc(complemento.id)).versoes[0].id;
    const candidatos = (await get(`livros/${livro}/complementos/candidatos`, 'gestor').expect(200)).body;
    expect(candidatos.map((v) => v.id)).toEqual([versao]);
    await post(`livros/${livro}/complementos`, 'gestor')
      .send({ ...cmd(fechado.revisao), versao_id: versao, motivo: 'Exame posterior' })
      .expect(201);
    expect(await detalheLivro()).toMatchObject({
      manifesto_sha256: fechado.manifesto_sha256,
      complementos: [{ versao_id: versao }],
    });
  }, 120000);

  it('preserva o scan restrito sem datas eletrônicas retroativas', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const arquivo = await app
      .get(PrivateStorageService)
      .save({ sub: atores.gestor, igreja_id: igreja }, Buffer.from(await pdf.save()));
    const { modalidade: _, perfil: __, reserva_exame: ___, ...identidade } = entradaLivro(20);
    const id = (
      await post('livros/importar', 'gestor')
        .send({
          ...identidade,
          restrito: true,
          arquivo_historico_id: arquivo.id,
          data_historica: '2021-01-01',
          autoridade: 'Custódia do livro',
          evidencia: 'Scan sintético conferido',
        })
        .expect(201)
    ).body.id;
    const lista = (await get(`livros?contexto=${contexto}`).expect(200)).body;
    expect(lista.map((item) => item.id)).not.toContain(id);
    const detalhe = (await get(`livros/${id}`, 'gestor').expect(200)).body;
    expect(detalhe).toMatchObject({
      estado: 'ENCERRADO',
      modalidade: 'FISICO_DIGITALIZADO',
      aberto_em: null,
      encerrado_em: null,
      manifesto_sha256: null,
      totais: null,
    });
    await get(`livros/${id}/arquivos/historico`, 'gestor').expect(200);
    await get(`livros/${id}/arquivos/historico`).expect(404);
  });
});
