import { PoliticaEleicaoService } from './politica-eleicao.service';
import { PrismaService } from '../prisma/prisma.service';
const tx = { usuarios: { findFirst: jest.fn() }, politica_eleicao_oficial: { create: jest.fn() }, logs_atividades: { create: jest.fn() } };
const db = { $transaction: jest.fn((fn: (arg: typeof tx) => unknown) => fn(tx)) };
const service = new PoliticaEleicaoService(db as unknown as PrismaService);
const input = { versao: '1', fonte: 'Norma', autoridade: 'Conselho', idade_minima: 18, aniversario_bissexto: 'DIA_28_FEVEREIRO' as const, vigente_desde: '2026-01-01', vigente_ate: null };
beforeEach(() => { jest.clearAllMocks(); tx.usuarios.findFirst.mockResolvedValue({ id: 'u' }); tx.politica_eleicao_oficial.create.mockResolvedValue({ id: 'p' }); tx.logs_atividades.create.mockResolvedValue({}); });
it('registra fonte e operador auditados na igreja', async () => {
  await service.registrar('igreja', 'u', input);
  expect(tx.usuarios.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ igreja_id: 'igreja', perfil: 'ADMINISTRADOR', ativo: true }) }));
  expect(tx.politica_eleicao_oficial.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ igreja_id: 'igreja', criado_por_id: 'u', autoridade: 'Conselho' }) }));
  expect(tx.logs_atividades.create).toHaveBeenCalledTimes(1);
});
it('recusa política inválida e operador sem perfil', async () => {
  await expect(service.registrar('igreja', 'u', { ...input, fonte: ' ' })).rejects.toThrow();
  tx.usuarios.findFirst.mockResolvedValue(null);
  await expect(service.registrar('igreja', 'u', input)).rejects.toThrow();
  expect(tx.politica_eleicao_oficial.create).not.toHaveBeenCalled();
});
