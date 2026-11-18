import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ParticipacaoService } from '../src/orgaos/participacao.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', admin = 'e1000000-0000-4000-8000-000000000001';
const data = (s: string) => new Date(`${s}T00:00:00Z`);

integration('E03: proteção de elegibilidade histórica', () => {
  const prisma = new PrismaService(), participacoes = new ParticipacaoService(prisma);
  const gestor = randomUUID(), pessoaGestor = randomUUID(), participante = randomUUID(), concorrente = randomUUID(), concorrente2 = randomUUID(), orgao = randomUUID();
  const evento = randomUUID(), hoje = new Date().toISOString().slice(0, 10);
  const ontem = new Date(data(hoje).getTime() - 86400000), amanha = new Date(data(hoje).getTime() + 86400000);
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await prisma.$connect();
    for (const id of [pessoaGestor, participante, concorrente, concorrente2]) await prisma.pessoas.create({ data: { id, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: data('1980-01-01'), sexo: 'FEMININO' } });
    await prisma.usuarios.create({ data: { id: gestor, igreja_id: igreja, pessoa_id: pessoaGestor, nome_usuario: 'Gestor sintético', email_login: `${gestor}@example.invalid`, senha_hash: 'inutilizavel', perfil: 'GESTOR' } });
    await prisma.competencia_unidades.create({ data: { igreja_id: igreja, usuario_id: gestor, pessoa_id: pessoaGestor, registrado_por: admin, inicio: data('2020-01-01'), autoridade: 'Autoridade', evidencia: 'Ato' } });
    await prisma.orgao_interno.create({ data: { id: orgao, igreja_id: igreja, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'DESIGNACAO', nome: 'Unidade sintética', finalidade: 'Teste', data_criacao: data('2020-01-01'), criador_id: gestor, instituidor_id: pessoaGestor, evidencia_instituicao: 'Ato' } });
    for (const pessoa_id of [participante, concorrente, concorrente2]) await prisma.eventos_membresia.create({ data: { id: pessoa_id === participante ? evento : randomUUID(), igreja_id: igreja, pessoa_id, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: data('2020-01-01') } });
  });
  afterAll(async () => {
    const atos = await prisma.ato_orgao.findMany({ where: { orgao_id: orgao }, select: { id: true } });
    await prisma.logs_atividades.deleteMany({ where: { registro_id: { in: atos.map(a => a.id) } } });
    await prisma.ato_orgao.deleteMany({ where: { orgao_id: orgao } });
    await prisma.membro_orgao.deleteMany({ where: { orgao_id: orgao } });
    await prisma.orgao_interno.deleteMany({ where: { id: orgao } });
    await prisma.competencia_unidades.deleteMany({ where: { usuario_id: gestor } });
    await prisma.usuarios.deleteMany({ where: { id: gestor } });
    await prisma.eventos_membresia.deleteMany({ where: { pessoa_id: { in: [participante, concorrente, concorrente2] } } });
    await prisma.pessoas.deleteMany({ where: { id: { in: [pessoaGestor, participante, concorrente, concorrente2] } } });
    await prisma.$disconnect();
  });

  it('bloqueia revisão anterior ao ato e permite registro posterior e alteração não relevante', async () => {
    await participacoes.alterar(igreja, gestor, orgao, 'INCLUSAO', { pessoa_id: participante, data_efeito: hoje, evidencia: 'Registro', idempotencia: randomUUID() });
    await expect(prisma.eventos_membresia.update({ where: { id: evento }, data: { rol: 'EXCLUIDOS' } })).rejects.toThrow();
    await expect(prisma.eventos_membresia.delete({ where: { id: evento } })).rejects.toThrow();
    await expect(prisma.eventos_membresia.update({ where: { id: evento }, data: { observacoes: 'Conferido' } })).resolves.toBeDefined();
    await expect(prisma.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: participante, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: amanha } })).resolves.toBeDefined();
  });

  it('relê o rol depois de aguardar uma alteração de membresia concorrente', async () => {
    let liberar!: () => void, avisar!: () => void;
    const pronto = new Promise<void>(resolve => { avisar = resolve; });
    const continuar = new Promise<void>(resolve => { liberar = resolve; });
    const alteracao = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${concorrente} AND igreja_id = ${igreja} FOR UPDATE`;
      await tx.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: concorrente, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: ontem } });
      avisar(); await continuar;
    });
    await pronto;
    const tentativa = participacoes.alterar(igreja, gestor, orgao, 'INCLUSAO', { pessoa_id: concorrente, data_efeito: hoje, evidencia: 'Registro', idempotencia: randomUUID() }).then(() => 'aceito', () => 'recusado');
    await new Promise(resolve => setTimeout(resolve, 100));
    liberar(); await alteracao;
    expect(await tentativa).toBe('recusado');
    expect(await prisma.membro_orgao.count({ where: { orgao_id: orgao, pessoa_id: concorrente } })).toBe(0);
  });

  it('uma alteração anterior aguarda a inclusão concorrente e é bloqueada', async () => {
    let liberar!: () => void, avisar!: () => void;
    const pronto = new Promise<void>(resolve => { avisar = resolve; });
    const continuar = new Promise<void>(resolve => { liberar = resolve; });
    const inclusao = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${concorrente2} AND igreja_id = ${igreja} FOR UPDATE`;
      await tx.membro_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao, pessoa_id: concorrente2, inicio: data(hoje) } });
      avisar(); await continuar;
    });
    await pronto;
    const alteracao = prisma.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: concorrente2, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: ontem } }).then(() => 'aceito', () => 'recusado');
    await new Promise(resolve => setTimeout(resolve, 100));
    liberar(); await inclusao;
    expect(await alteracao).toBe('recusado');
    expect(await prisma.eventos_membresia.count({ where: { igreja_id: igreja, pessoa_id: concorrente2 } })).toBe(1);
  });
});
