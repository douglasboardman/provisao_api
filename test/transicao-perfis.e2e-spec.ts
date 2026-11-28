import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { RotasServicosService } from '../src/autorizacao/rotas-servicos.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { usuarios_perfil } from '@prisma/client';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;

integration('Atribuições de serviço', () => {
  let app: INestApplication, db: PrismaService, admin: string, comum: string;
  let igreja: string, outra: string;
  const cookies = new Map<string, string>();
  const novoCadastro = { nome_completo: 'Pessoa de ensaio', sexo: 'FEMININO', data_nascimento: '1990-04-20' };
  const fundamento = 'Homologação do serviço para esta igreja';

  function http(id: string, metodo: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string) {
    return request(app.getHttpServer())[metodo](path).set('Cookie', cookies.get(id)!)
      .set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  }
  async function abrirSessao(id: string) {
    const u = await db.usuarios.findUniqueOrThrow({ where: { id } });
    cookies.set(id, 'provisao_session=' + await app.get(SessionService).create(id, u.igreja_id, u.auth_version));
  }
  async function conta(perfil: usuarios_perfil, igreja_id = igreja) {
    const p = await db.pessoas.create({ data: { igreja_id, ...novoCadastro, sexo: 'FEMININO', data_nascimento: new Date(novoCadastro.data_nascimento) } });
    const u = await db.usuarios.create({ data: { igreja_id, perfil, pessoa_id: p.id, nome_usuario: randomUUID(),
      email_login: randomUUID() + '@example.invalid', senha_hash: 'inutilizavel' } });
    await abrirSessao(u.id);
    return u.id;
  }
  const dar = (id: string, acao: string, fim: string | null = null) => http(admin, 'post', `/autorizacao/contas/${id}/atribuicoes`)
    .send({ acao, inicio: new Date(Date.now() - 1000).toISOString(), fim, fundamento });

  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public')
      throw new Error('Exige banco descartável E00.');
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.listen(0, '127.0.0.1');
    db = app.get(PrismaService);
    igreja = (await db.igreja.create({ data: { nome: 'Igreja da transição', mfa_obrigatorio: false } })).id;
    outra = (await db.igreja.create({ data: { nome: 'Outra igreja' } })).id;
    admin = await conta('ADMINISTRADOR');
    comum = await conta('COMUM');
    await db.$executeRaw`SELECT instalar_estrutura_institucional(${igreja})`;
  });

  afterAll(async () => { await app?.close(); });

  it('fecha o acesso direto a todas as rotas econômicas e administrativas inventariadas sem serviço', async () => {
    const rotas = app.get(RotasServicosService).listar();
    expect(rotas.length).toBeGreaterThan(75);
    for (const r of rotas.filter(r => !r.contextual)) {
      const [verbo, path] = r.rota.split(' ');
      const endereco = path.replace(/:\w+/g, randomUUID());
      await http(comum, verbo.toLowerCase() as Parameters<typeof http>[1], endereco).expect(403);
    }
  });

  it('consulta e aprova pedidos por serviços separados, criando conta comum', async () => {
    const pedido = await db.solicitacao_acesso.create({ data: { igreja_id: igreja, nome_usuario: 'Nova conta',
      email_login: randomUUID() + '@example.invalid', estado: 'EM_ANALISE' } });
    await dar(comum, 'ACESSO_CONSULTAR').expect(201);
    await http(comum, 'get', '/solicitacoes-acesso').expect(200);
    await http(comum, 'patch', '/solicitacoes-acesso/' + pedido.id + '/aprovar').expect(403);
    await dar(comum, 'ACESSO_ANALISAR').expect(201);
    await http(comum, 'patch', '/solicitacoes-acesso/' + pedido.id + '/aprovar').expect(200);
    const aprovado = await db.solicitacao_acesso.findUniqueOrThrow({ where: { id: pedido.id } });
    expect(await db.usuarios.findUnique({ where: { id: aprovado.usuario_id! } })).toMatchObject({ perfil: 'COMUM', pessoa_id: null });
  });

  it('retira a Secretaria e a ficha de órgão da navegação ao terminar o cargo', async () => {
    const usuario = await conta('COMUM');
    const pessoa_id = (await db.usuarios.update({ where: { id: usuario }, data: { conta_atuacao: true } })).pessoa_id!;
    const inicio = new Date('2025-11-01');
    await db.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id, data_evento: inicio, tipo_evento: 'ADMISSAO',
      rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE' } });
    await db.pessoas.update({ where: { id: pessoa_id }, data: { sexo: 'MASCULINO' } });
    const orgao = await db.orgao_interno.findFirstOrThrow({ where: { igreja_id: igreja, tipo_padrao: 'CONSELHO' },
      include: { contexto_secretaria: true, cargos: true } });
    const oficial = await db.oficial.create({ data: { igreja_id: igreja, pessoa_id, tipo: 'PRESBITERO_REGENTE' } });
    await db.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, tipo: 'ORDENACAO', data_efeito: inicio, ordem: 1,
      autoridade: 'Conselho', evidencia: fundamento } });
    await db.mandato_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, data_eleicao: inicio,
      data_posse: inicio, termino_previsto: new Date('2030-10-31'), autoridade: 'Assembleia', evidencia: fundamento, avaliacao_eleicao: {} } });
    const cargo = orgao.cargos.find(c => c.codigo === 'SECRETARIO')!;
    const ocupacao = await db.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgao.id, cargo_id: cargo.id, pessoa_id, inicio } });
    const navegar = () => http(usuario, 'get', '/autorizacao/navegacao').expect(200);
    const rota = '/secretaria/contextos/' + orgao.contexto_secretaria!.id + '/resumo';
    expect((await navegar()).body.permissoes).toMatchObject({ secretaria: ['view'], orgaos: ['view'], usuarios: [] });
    await http(usuario, 'get', rota).expect(200);
    const hoje = new Date(new Date().toISOString().slice(0, 10));
    await db.ocupacao_cargo.update({ where: { id: ocupacao.id }, data: { fim: hoje, fim_ordem: 1 } });
    expect((await navegar()).body.permissoes).toMatchObject({ secretaria: [], orgaos: [] });
    await http(usuario, 'get', rota).expect(404);
  });
});
