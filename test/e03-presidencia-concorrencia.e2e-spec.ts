import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PresidenciaService } from '../src/orgaos/presidencia.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', admin = 'e1000000-0000-4000-8000-000000000001';
const outra = 'e0000000-0000-4000-8000-000000000002', adminOutra = 'e1000000-0000-4000-8000-000000000002';

integration('E03: presidência e correção cadastral concorrente', () => {
  const prisma = new PrismaService(), presidencias = new PresidenciaService(prisma);
  const pessoa = randomUUID(), oficial = randomUUID(), chave = randomUUID();
  const outraPessoa = randomUUID(), outroOficial = randomUUID();
  let presidencia = '';
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await prisma.$connect();
    await prisma.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Docente sintético', data_nascimento: new Date('1980-01-01'), sexo: 'MASCULINO' } });
    await prisma.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'PRESBITERO_DOCENTE' } });
    await prisma.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial, tipo: 'ORDENACAO', data_efeito: new Date('2020-01-01'), ordem: 1, autoridade: 'Concílio', evidencia: 'Ato' } });
    await prisma.vinculo_pastoral.create({ data: { igreja_id: igreja, oficial_id: oficial, modalidade: 'Pastor', concilio: 'Concílio', ato: 'Vínculo', data_inicio: new Date('2020-01-01'), exercicio_institucional: true, evidencia: 'Ato' } });
    await prisma.pessoas.create({ data: { id: outraPessoa, igreja_id: outra, nome_completo: 'Docente sintético', data_nascimento: new Date('1980-01-01'), sexo: 'MASCULINO' } });
    await prisma.oficial.create({ data: { id: outroOficial, igreja_id: outra, pessoa_id: outraPessoa, tipo: 'PRESBITERO_DOCENTE' } });
  });
  afterAll(async () => {
    await prisma.logs_atividades.deleteMany({ where: { tabela_afetada: 'presidencia_conselho', registro_id: presidencia } });
    await prisma.requisicao_institucional.deleteMany({ where: { igreja_id: igreja, idempotencia: chave } });
    await prisma.presidencia_conselho.deleteMany({ where: { oficial_id: oficial } });
    await prisma.presidencia_conselho.deleteMany({ where: { oficial_id: outroOficial } });
    await prisma.vinculo_pastoral.deleteMany({ where: { oficial_id: oficial } });
    await prisma.evento_oficial.deleteMany({ where: { oficial_id: oficial } });
    await prisma.oficial.deleteMany({ where: { id: oficial } });
    await prisma.oficial.deleteMany({ where: { id: outroOficial } });
    await prisma.pessoas.deleteMany({ where: { id: pessoa } });
    await prisma.pessoas.deleteMany({ where: { id: outraPessoa } });
    await prisma.$disconnect();
  });

  it('relê o cadastro após alteração concorrente e preserva o dado usado depois do ato', async () => {
    let liberar!: () => void, avisar!: () => void;
    const pronto = new Promise<void>(resolve => { avisar = resolve; });
    const continuar = new Promise<void>(resolve => { liberar = resolve; });
    const alteracao = prisma.$transaction(async tx => {
      await tx.pessoas.update({ where: { id: pessoa }, data: { sexo: 'FEMININO' } });
      avisar(); await continuar;
    });
    await pronto;
    const tentativa = presidencias.registrar(igreja, admin, { oficial_id: oficial, inicio: '2020-01-01', evidencia: 'Ato', idempotencia: chave }).then(() => 'aceito', () => 'recusado');
    await new Promise(resolve => setTimeout(resolve, 100));
    liberar(); await alteracao;
    expect(await tentativa).toBe('recusado');
    expect(await prisma.presidencia_conselho.count({ where: { oficial_id: oficial } })).toBe(0);
    await prisma.pessoas.update({ where: { id: pessoa }, data: { sexo: 'MASCULINO' } });
    presidencia = (await presidencias.registrar(igreja, admin, { oficial_id: oficial, inicio: '2020-01-01', evidencia: 'Ato', idempotencia: chave })).id;
    await expect(prisma.pessoas.update({ where: { id: pessoa }, data: { sexo: 'FEMININO' } })).rejects.toThrow();
    await expect(prisma.pessoas.update({ where: { id: pessoa }, data: { nome_completo: 'Docente sintético revisado' } })).resolves.toBeDefined();
  });

  it('bloqueia correção que aguarda um registro de presidência concorrente', async () => {
    let liberar!: () => void, avisar!: () => void;
    const pronto = new Promise<void>(resolve => { avisar = resolve; });
    const continuar = new Promise<void>(resolve => { liberar = resolve; });
    const registro = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${outraPessoa} AND igreja_id = ${outra} FOR UPDATE`;
      await tx.presidencia_conselho.create({ data: { igreja_id: outra, oficial_id: outroOficial, inicio: new Date('2020-01-01'), evidencia: 'Ato sintético', registrado_por: adminOutra } });
      avisar(); await continuar;
    });
    await pronto;
    const alteracao = prisma.pessoas.update({ where: { id: outraPessoa }, data: { sexo: 'FEMININO' } }).then(() => 'aceito', () => 'recusado');
    await new Promise(resolve => setTimeout(resolve, 100));
    liberar(); await registro;
    expect(await alteracao).toBe('recusado');
    expect((await prisma.pessoas.findUniqueOrThrow({ where: { id: outraPessoa } })).sexo).toBe('MASCULINO');
  });
});
