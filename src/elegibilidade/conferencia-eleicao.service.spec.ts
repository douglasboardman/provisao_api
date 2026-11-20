import { ConferenciaEleicaoService } from './conferencia-eleicao.service';
import { PrismaService } from '../prisma/prisma.service';
const igreja = 'e0000000-0000-4000-8000-000000000001', pessoa = 'e2000000-0000-4000-8000-000000000001', politica = 'e3000000-0000-4000-8000-000000000001', usuario = 'e1000000-0000-4000-8000-000000000001';
const dados = { pessoa_id: pessoa, politica_id: politica, data_eleicao: '2026-01-01', candidatura_aprovada_conselho: true };
const admissao = { id: 'admissao', data_evento: new Date('2025-01-01'), rol: 'COMUNGANTES', rol_origem: null, tipo_evento: 'ADMISSAO', motivacao_evento: 'PROFISSAO_DE_FE' };
const cadastro = { id: pessoa, data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' };
const tx = { $queryRaw: jest.fn().mockResolvedValue([]), pessoas: { findFirst: jest.fn() }, politica_eleicao_oficial: { findFirst: jest.fn() }, usuarios: { findFirst: jest.fn() }, eventos_membresia: { findMany: jest.fn() }, conferencia_eleicao_oficial: { create: jest.fn() }, logs_atividades: { create: jest.fn() } };
const prisma = { $transaction: jest.fn((fn: (value: typeof tx) => unknown) => fn(tx)) };
const service = new ConferenciaEleicaoService(prisma as unknown as PrismaService);
beforeEach(() => {
  jest.clearAllMocks();
  tx.pessoas.findFirst.mockResolvedValue(cadastro);
  tx.politica_eleicao_oficial.findFirst.mockResolvedValue({ id: politica, idade_minima: 18, fonte: 'Norma', versao: '1', vigente_desde: new Date('2025-01-01'), aniversario_bissexto: 'DIA_28_FEVEREIRO' });
  tx.usuarios.findFirst.mockResolvedValue({ id: usuario });
  tx.eventos_membresia.findMany.mockResolvedValue([admissao]);
  tx.conferencia_eleicao_oficial.create.mockImplementation(({ data }) => Promise.resolve({ id: 'conferencia', ...data }));
  tx.logs_atividades.create.mockResolvedValue({});
});
describe('conferência eleitoral', () => {
  it('registra retrato e auditoria na transação com escopo de igreja', async () => {
    const resultado = await service.registrar(igreja, usuario, dados);
    expect(resultado).toMatchObject({
      data_recepcao: admissao.data_evento,
      evidencia_recepcao: expect.stringContaining(admissao.id),
      capacidade_confirmada: true,
      evidencia_capacidade: expect.stringContaining('Aprovação da candidatura pelo Conselho'),
      resultado: { situacao: 'REQUISITOS_CONFERIDOS', evento_recepcao_id: admissao.id },
    });
    expect(tx.pessoas.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: pessoa, igreja_id: igreja } }));
    expect(tx.logs_atividades.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ igreja_id: igreja, usuario_id: usuario }) }));
  });
  it('não presume ordem de eventos de mesmo dia', async () => {
    tx.eventos_membresia.findMany.mockResolvedValue([admissao, { ...admissao, id: 'saida', rol: 'EXCLUIDOS', tipo_evento: 'DEMISSAO' }]);
    await expect(service.registrar(igreja, usuario, dados)).rejects.toThrow('membresia comungante comprovada');
    expect(tx.conferencia_eleicao_oficial.create).not.toHaveBeenCalled();
  });
  it('rejeita pessoa de outra igreja e entradas inválidas', async () => {
    tx.pessoas.findFirst.mockResolvedValue(null);
    await expect(service.registrar(igreja, usuario, dados)).rejects.toThrow();
    await expect(service.registrar(igreja, usuario, { ...dados, data_eleicao: '2026-02-30' })).rejects.toThrow();
    expect(tx.conferencia_eleicao_oficial.create).not.toHaveBeenCalled();
  });
  it('usa sequência explícita no mesmo dia sem inferir pela inserção', async () => {
    tx.eventos_membresia.findMany.mockResolvedValue([
      { ...admissao, id: 'ultimo', ordem_dia: 2, rol_origem: 'NAO_COMUNGANTES', tipo_evento: 'MUDANCA_DE_ROL' },
      { ...admissao, id: 'primeiro', ordem_dia: 1, rol: 'NAO_COMUNGANTES', motivacao_evento: 'BATISMO_NA_INFANCIA' },
    ]);
    expect((await service.registrar(igreja, usuario, dados)).resultado).toMatchObject({
      situacao: 'REQUISITOS_CONFERIDOS', evento_membresia_id: 'ultimo', evento_recepcao_id: 'primeiro',
    });
  });
  it('usa a restauração para datar o novo vínculo e aplica o prazo de recepção', async () => {
    const saida = { ...admissao, id: 'saida', data_evento: new Date('2025-03-01'), rol: 'EXCLUIDOS', tipo_evento: 'DEMISSAO' };
    const restauracao = { ...admissao, id: 'retorno', data_evento: new Date('2025-07-01'), rol_origem: 'EXCLUIDOS', motivacao_evento: 'RESTAURACAO' };
    tx.eventos_membresia.findMany.mockResolvedValue([admissao, saida, restauracao]);
    const resultado = await service.registrar(igreja, usuario, dados);
    expect(resultado).toMatchObject({
      data_recepcao: restauracao.data_evento,
      resultado: { situacao: 'REQUISITOS_NAO_ATENDIDOS', evento_recepcao_id: 'retorno', requisitos: expect.arrayContaining([expect.objectContaining({ requisito: 'prazo_recepcao', atendido: false })]) },
    });
  });
  it('exige ingresso documentado mesmo quando há um evento comungante', async () => {
    tx.eventos_membresia.findMany.mockResolvedValue([{ ...admissao, tipo_evento: 'MUDANCA_DE_ROL', rol_origem: 'NAO_COMUNGANTES' }]);
    await expect(service.registrar(igreja, usuario, dados)).rejects.toThrow('evento que iniciou o vínculo');
  });
  it('exige sexo masculino e registra quando a aprovação do Conselho não é declarada', async () => {
    tx.pessoas.findFirst.mockResolvedValueOnce({ ...cadastro, sexo: 'FEMININO' });
    await expect(service.registrar(igreja, usuario, dados)).rejects.toThrow('sexo masculino');
    expect(await service.registrar(igreja, usuario, { ...dados, candidatura_aprovada_conselho: false })).toMatchObject({
      capacidade_confirmada: false, evidencia_capacidade: '', resultado: { situacao: 'REQUISITOS_NAO_ATENDIDOS' },
    });
  });
});
