import { ConferenciaEleicaoService } from './conferencia-eleicao.service';
import { PrismaService } from '../prisma/prisma.service';
const igreja = 'e0000000-0000-4000-8000-000000000001', pessoa = 'e2000000-0000-4000-8000-000000000001', politica = 'e3000000-0000-4000-8000-000000000001', usuario = 'e1000000-0000-4000-8000-000000000001';
const dados = { pessoa_id: pessoa, politica_id: politica, data_eleicao: '2026-01-01', data_recepcao: '2025-01-01', evidencia_recepcao: 'Livro externo', capacidade_confirmada: true, evidencia_capacidade: 'Declaração' };
const tx = { $queryRaw: jest.fn().mockResolvedValue([]), pessoas: { findFirst: jest.fn() }, politica_eleicao_oficial: { findFirst: jest.fn() }, usuarios: { findFirst: jest.fn() }, eventos_membresia: { findMany: jest.fn() }, conferencia_eleicao_oficial: { create: jest.fn() }, logs_atividades: { create: jest.fn() } };
const prisma = { $transaction: jest.fn((fn: (value: typeof tx) => unknown) => fn(tx)) };
const service = new ConferenciaEleicaoService(prisma as unknown as PrismaService);
beforeEach(() => {
  jest.clearAllMocks();
  tx.pessoas.findFirst.mockResolvedValue({ id: pessoa, data_nascimento: new Date('1990-01-01') });
  tx.politica_eleicao_oficial.findFirst.mockResolvedValue({ id: politica, idade_minima: 18, fonte: 'Norma', versao: '1', vigente_desde: new Date('2025-01-01'), aniversario_bissexto: 'DIA_28_FEVEREIRO' });
  tx.usuarios.findFirst.mockResolvedValue({ id: usuario });
  tx.eventos_membresia.findMany.mockResolvedValue([{ id: 'evento', data_evento: new Date('2025-01-01'), rol: 'COMUNGANTES' }]);
  tx.conferencia_eleicao_oficial.create.mockImplementation(({ data }) => Promise.resolve({ id: 'conferencia', ...data }));
  tx.logs_atividades.create.mockResolvedValue({});
});
describe('conferência eleitoral', () => {
  it('registra retrato e auditoria na transação com escopo de igreja', async () => {
    const resultado = await service.registrar(igreja, usuario, dados);
    expect(resultado.resultado).toMatchObject({ situacao: 'REQUISITOS_CONFERIDOS' });
    expect(tx.pessoas.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: pessoa, igreja_id: igreja } }));
    expect(tx.logs_atividades.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ igreja_id: igreja, usuario_id: usuario }) }));
  });
  it('não presume ordem de eventos de mesmo dia', async () => {
    tx.eventos_membresia.findMany.mockResolvedValue([{ id: 'a', data_evento: new Date('2025-01-01'), rol: 'COMUNGANTES' }, { id: 'b', data_evento: new Date('2025-01-01'), rol: 'EXCLUIDOS' }]);
    expect((await service.registrar(igreja, usuario, dados)).resultado).toMatchObject({ situacao: 'INDETERMINADA' });
  });
  it('rejeita pessoa de outra igreja e entradas inválidas', async () => {
    tx.pessoas.findFirst.mockResolvedValue(null);
    await expect(service.registrar(igreja, usuario, dados)).rejects.toThrow();
    await expect(service.registrar(igreja, usuario, { ...dados, data_eleicao: '2026-02-30' })).rejects.toThrow();
    expect(tx.conferencia_eleicao_oficial.create).not.toHaveBeenCalled();
  });
  it('usa sequência explícita no mesmo dia sem inferir pela inserção', async () => {
    tx.eventos_membresia.findMany.mockResolvedValue([
      { id: 'ultimo', data_evento: new Date('2025-01-01'), ordem_dia: 2, rol: 'COMUNGANTES' },
      { id: 'primeiro', data_evento: new Date('2025-01-01'), ordem_dia: 1, rol: 'NAO_COMUNGANTES' },
    ]);
    expect((await service.registrar(igreja, usuario, dados)).resultado).toMatchObject({ situacao: 'REQUISITOS_CONFERIDOS', evento_membresia_id: 'ultimo' });
  });

});
