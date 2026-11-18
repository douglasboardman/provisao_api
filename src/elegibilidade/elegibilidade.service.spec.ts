import { NotFoundException } from '@nestjs/common';
import { membresia_rol } from '@prisma/client';
import { ElegibilidadeService } from './elegibilidade.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ElegibilidadeService', () => {
  const db = { pessoas: { findFirst: jest.fn() }, eventos_membresia: { findMany: jest.fn() } };
  const service = new ElegibilidadeService(db as unknown as PrismaService);
  const data = new Date('2026-11-16T00:00:00.000Z');
  beforeEach(() => { jest.resetAllMocks(); db.pessoas.findFirst.mockResolvedValue({ id: 'p' }); db.eventos_membresia.findMany.mockResolvedValue([]); });
  it('restringe pessoa e eventos à igreja e exclui eventos futuros', async () => {
    await service.avaliar('i', 'p', data, 'LIDERANCA_UNIDADE');
    expect(db.pessoas.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p', igreja_id: 'i' } }));
    expect(db.eventos_membresia.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { igreja_id: 'i', pessoa_id: 'p', data_evento: { lte: data } } }));
  });
  it('recusa pessoa fora do escopo', async () => {
    db.pessoas.findFirst.mockResolvedValue(null);
    await expect(service.avaliar('i', 'p', data, 'ELEICAO_OFICIAL')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('não presume situação sem histórico ou com eventos simultâneos', async () => {
    expect((await service.avaliar('i', 'p', data, 'LIDERANCA_UNIDADE')).situacao).toBe('INDETERMINADA');
    db.eventos_membresia.findMany.mockResolvedValue([{ data_evento: data, rol: membresia_rol.COMUNGANTES }, { data_evento: data, rol: membresia_rol.EXCLUIDOS }]);
    expect((await service.avaliar('i', 'p', data, 'LIDERANCA_UNIDADE')).situacao).toBe('INDETERMINADA');
  });
  it.each([membresia_rol.ROL_SEPARADO, membresia_rol.EXCLUIDOS])('rejeita rol %s', async rol => {
    db.eventos_membresia.findMany.mockResolvedValue([{ data_evento: data, rol }]);
    expect((await service.avaliar('i', 'p', data, 'PARTICIPACAO_UNIDADE')).situacao).toBe('INELEGIVEL');
  });
  it('distingue participação, liderança e eleição de oficial', async () => {
    db.eventos_membresia.findMany.mockResolvedValue([{ data_evento: data, rol: membresia_rol.NAO_COMUNGANTES }]);
    expect((await service.avaliar('i', 'p', data, 'PARTICIPACAO_UNIDADE')).situacao).toBe('ELEGIVEL');
    expect((await service.avaliar('i', 'p', data, 'LIDERANCA_UNIDADE')).situacao).toBe('INELEGIVEL');
    db.eventos_membresia.findMany.mockResolvedValue([{ data_evento: data, rol: membresia_rol.COMUNGANTES }]);
    expect((await service.avaliar('i', 'p', data, 'LIDERANCA_UNIDADE')).situacao).toBe('ELEGIVEL');
    expect((await service.avaliar('i', 'p', data, 'ELEICAO_OFICIAL')).situacao).toBe('INDETERMINADA');
  });
});
