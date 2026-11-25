import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrgaosOficiaisService } from '../src/orgaos/orgaos-oficiais.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001';
const outra = 'e0000000-0000-4000-8000-000000000002';
const usuario = 'e1000000-0000-4000-8000-000000000001';
const pessoa = 'e2000000-0000-4000-8000-000000000001';
const pessoaOutra = 'e2000000-0000-4000-8000-000000000002';

integration('E03: integridade de órgãos no banco descartável', () => {
  const prisma = new PrismaService();
  const orgaoId = randomUUID(), cargoId = randomUUID();
  let conselhoId: string | undefined;
  let juntaId: string | undefined;
  const data = (s: string) => new Date(`${s}T00:00:00Z`);
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await prisma.$connect();
    await prisma.orgao_interno.create({ data: { id: orgaoId, igreja_id: igreja, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'DESIGNACAO', nome: 'Unidade sintética', finalidade: 'Teste', data_criacao: data('2026-01-01'), criador_id: usuario, instituidor_id: pessoa, evidencia_instituicao: 'Referência sintética' } });
    await prisma.cargo_orgao.create({ data: { id: cargoId, igreja_id: igreja, orgao_id: orgaoId, codigo: 'LIDER', nome: 'Líder' } });
  });
  afterAll(async () => {
    for (const id of [conselhoId, juntaId].filter((id): id is string => !!id)) {
      await prisma.logs_atividades.deleteMany({ where: { registro_id: id } });
      await prisma.ato_orgao.deleteMany({ where: { orgao_id: id } });
      await prisma.cargo_orgao.deleteMany({ where: { orgao_id: id } });
      await prisma.contexto_secretaria.deleteMany({ where: { orgao_id: id } });
      await prisma.versao_orgao.deleteMany({ where: { orgao_id: id } });
      await prisma.orgao_interno.deleteMany({ where: { id } });
    }
    await prisma.ocupacao_cargo.deleteMany({ where: { orgao_id: orgaoId } });
    await prisma.membro_orgao.deleteMany({ where: { orgao_id: orgaoId } });
    await prisma.cargo_orgao.deleteMany({ where: { orgao_id: orgaoId } });
    await prisma.orgao_interno.deleteMany({ where: { id: orgaoId } });
    await prisma.$disconnect();
  });

  it('cadastra Conselho sem instituidor ou evidências, preserva auditoria e impede duplicidade', async () => {
    const service = new OrgaosOficiaisService(prisma);
    const dados = { tipo: 'CONSELHO' as const, nome: 'Conselho sintético', finalidade: 'Teste', data_criacao: '2020-01-01', idempotencia: randomUUID() };
    await expect(service.registrar(igreja, usuario, Object.assign({}, dados, { instituidor_id: pessoaOutra }))).rejects.toThrow();
    const conselho = await service.registrar(igreja, usuario, dados);
    conselhoId = conselho.id;
    expect(await prisma.orgao_interno.findUnique({ where: { id: conselhoId } })).toMatchObject({ instituidor_id: null, evidencia_instituicao: null, criador_id: usuario });
    const registro = await prisma.ato_orgao.findFirstOrThrow({ where: { orgao_id: conselhoId } });
    expect(registro).toMatchObject({ tipo: 'CADASTRO_OFICIAL', autoridade: null, evidencia: null, operador_id: usuario });
    expect(await prisma.$queryRaw`SELECT acompanha FROM e09_alvo WHERE alvo_id = ${registro.id}`).toEqual([{ acompanha: false }]);
    expect(await service.registrar(igreja, usuario, dados)).toEqual(conselho);
    await expect(service.registrar(igreja, usuario, { ...dados, nome: 'Outro' })).rejects.toThrow('Chave de repetição');
    expect(await prisma.cargo_orgao.count({ where: { orgao_id: conselho.id, codigo: 'PRESIDENTE' } })).toBe(0);
    await expect(service.registrar(igreja, usuario, { ...dados, idempotencia: randomUUID() })).rejects.toThrow();
    await expect(service.registrar(outra, usuario, { ...dados, idempotencia: randomUUID() })).rejects.toThrow('Operador não autorizado');
  });

  it('cadastra Junta sem depender de pessoa e mantém seus cargos próprios', async () => {
    const service = new OrgaosOficiaisService(prisma);
    const junta = await service.registrar(igreja, usuario, { tipo: 'JUNTA', nome: 'Junta sintética', finalidade: 'Teste', data_criacao: '2020-01-01', idempotencia: randomUUID() });
    juntaId = junta.id;
    expect(await prisma.cargo_orgao.count({ where: { orgao_id: juntaId, codigo: 'PRESIDENTE' } })).toBe(1);
    expect(await prisma.orgao_interno.findUnique({ where: { id: juntaId } })).toMatchObject({ instituidor_id: null, evidencia_instituicao: null });
  });

  it('mantém a exigência de instituidor e evidência para unidades e de evidência para atos institucionais', async () => {
    await expect(prisma.orgao_interno.create({ data: { igreja_id: igreja, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'DESIGNACAO', nome: 'Sem evidência', finalidade: 'Teste', data_criacao: data('2020-01-01'), criador_id: usuario } })).rejects.toThrow();
    await expect(prisma.ato_orgao.create({ data: { igreja_id: igreja, orgao_id: orgaoId, operador_id: usuario, tipo: 'DESIGNACAO', data_efeito: data('2020-01-01'), detalhes: {} } })).rejects.toThrow();
    await expect(prisma.ato_orgao.create({ data: { igreja_id: igreja, orgao_id: orgaoId, operador_id: usuario, tipo: 'CADASTRO_OFICIAL', data_efeito: data('2020-01-01'), detalhes: {} } })).rejects.toThrow();
  });

  it('rejeita referências a pessoas e órgãos de outra igreja', async () => {
    await expect(prisma.membro_orgao.create({ data: { igreja_id: igreja, orgao_id: orgaoId, pessoa_id: pessoaOutra, inicio: data('2026-01-01') } })).rejects.toThrow();
    await expect(prisma.membro_orgao.create({ data: { igreja_id: outra, orgao_id: orgaoId, pessoa_id: pessoaOutra, inicio: data('2026-01-01') } })).rejects.toThrow();
  });

  it('não aceita chave de repetição sem a impressão digital do pedido', async () => {
    await expect(prisma.ato_orgao.create({ data: { igreja_id: igreja, orgao_id: orgaoId, operador_id: usuario, tipo: 'TESTE', data_efeito: data('2026-01-01'), autoridade: 'Autoridade', evidencia: 'Ato', detalhes: {}, idempotencia: randomUUID() } })).rejects.toThrow();
  });

  it('impede dois titulares concorrentes e admite sucessão na data efetiva', async () => {
    const primeiro = await prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgaoId, cargo_id: cargoId, pessoa_id: pessoa, inicio: data('2026-01-01') } });
    await expect(prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgaoId, cargo_id: cargoId, pessoa_id: pessoa, inicio: data('2026-06-01') } })).rejects.toThrow();
    await prisma.ocupacao_cargo.update({ where: { id: primeiro.id }, data: { fim: data('2026-06-01'), fim_ordem: 1 } });
    await expect(prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgaoId, cargo_id: cargoId, pessoa_id: pessoa, inicio: data('2026-06-01') } })).resolves.toBeDefined();
  });

  it('a restrição resolve inclusões concorrentes para um mesmo cargo', async () => {
    const cargo = await prisma.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: orgaoId, codigo: 'VICE', nome: 'Vice-líder' } });
    const criar = () => prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgaoId, cargo_id: cargo.id, pessoa_id: pessoa, inicio: data('2026-01-01') } });
    const resultados = await Promise.allSettled([criar(), criar()]);
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(resultados.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.ocupacao_cargo.count({ where: { cargo_id: cargo.id } })).toBe(1);
  });

  it('exige ordem válida e impede sobreposição dentro do mesmo dia', async () => {
    const cargo = await prisma.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: orgaoId, codigo: 'MESMO_DIA', nome: 'Cargo sintético' } });
    const inicio = data('2026-03-01');
    const primeiro = await prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgaoId, cargo_id: cargo.id, pessoa_id: pessoa, inicio, inicio_ordem: 2 } });
    await expect(prisma.ocupacao_cargo.update({ where: { id: primeiro.id }, data: { fim: inicio } })).rejects.toThrow();
    await expect(prisma.ocupacao_cargo.update({ where: { id: primeiro.id }, data: { fim: inicio, fim_ordem: 2 } })).rejects.toThrow();
    await prisma.ocupacao_cargo.update({ where: { id: primeiro.id }, data: { fim: inicio, fim_ordem: 3 } });
    await expect(prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgaoId, cargo_id: cargo.id, pessoa_id: pessoa, inicio, inicio_ordem: 2 } })).rejects.toThrow();
    await expect(prisma.ocupacao_cargo.create({ data: { igreja_id: igreja, orgao_id: orgaoId, cargo_id: cargo.id, pessoa_id: pessoa, inicio, inicio_ordem: 3 } })).resolves.toBeDefined();
  });
});
