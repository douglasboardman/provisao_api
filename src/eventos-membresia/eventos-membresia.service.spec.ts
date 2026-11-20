import { Test, TestingModule } from '@nestjs/testing';
import { EventosMembresiaService } from './eventos-membresia.service';
import { RegrasRelacaoEnumService } from '../regras-relacao-enum/regras-relacao-enum.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  membresia_tipo_evento as TipoEvento,
  membresia_rol as MembresiaRol,
  membresia_motivacao_evento as MotivacaoEvento,
} from '@prisma/client';

const IGREJA_ID = 'igreja-uuid';
const PESSOA_ID = 'pessoa-uuid';

const regras = {
  'Motivações de Admissão': { ADMISSAO: ['PROFISSAO_DE_FE'] },
  'Motivações de Demissão': { DEMISSAO: ['EXCLUSAO_POR_DISCIPLINA', 'FALECIMENTO'] },
  'Motivações de Mudança de Rol': { MUDANCA_DE_ROL: ['PROFISSAO_DE_FE', 'PARADEIRO_IGNORADO'] },
  'Rols de Admissão': { ADMISSAO: ['COMUNGANTES', 'NAO_COMUNGANTES'] },
  'Rols de Mudança de Rol': { MUDANCA_DE_ROL: ['COMUNGANTES', 'NAO_COMUNGANTES', 'ROL_SEPARADO'] },
  'Motivações por Rol de Destino': { COMUNGANTES: ['PROFISSAO_DE_FE'], ROL_SEPARADO: ['PARADEIRO_IGNORADO'] },
  'Rol de Destino por Motivação de Demissão': { EXCLUSAO_POR_DISCIPLINA: ['EXCLUIDOS'], FALECIMENTO: ['ROL_SEPARADO'] },
};

const mockPrisma = {
  regras_relacao_enum: {
    findMany: jest.fn(async () => Object.entries(regras).map(([nome, entradas]) => ({
      nome,
      parametros_igreja: [],
      valores: Object.entries(entradas).flatMap(
        ([valor_classificador, valores]) => (valores as string[]).map(valor_classificado => ({ valor_classificador, valor_classificado })),
      ),
    }))),
  },
  pessoas: { findFirst: jest.fn() },
  eventos_membresia: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

describe('EventosMembresiaService', () => {
  let service: EventosMembresiaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventosMembresiaService,
        RegrasRelacaoEnumService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(EventosMembresiaService);
    jest.clearAllMocks();
    mockPrisma.eventos_membresia.findFirst.mockReset();
    mockPrisma.eventos_membresia.findMany.mockReset().mockResolvedValue([]);
  });

  describe('create', () => {
    const baseDto = {
      pessoa_id: PESSOA_ID,
      tipo_evento: TipoEvento.ADMISSAO,
      rol: MembresiaRol.COMUNGANTES,
      motivacao_evento: MotivacaoEvento.PROFISSAO_DE_FE,
      data_evento: new Date('2025-01-15'),
    };

    it('should reject if pessoa not in igreja', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue(null);
      await expect(service.create(IGREJA_ID, baseDto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject admissão motivacao for DEMISSAO', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.DEMISSAO,
        motivacao_evento: MotivacaoEvento.PROFISSAO_DE_FE,
      };
      await expect(service.create(IGREJA_ID, dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject demissão motivacao for ADMISSAO', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      const dto = {
        ...baseDto,
        motivacao_evento: MotivacaoEvento.EXCLUSAO_POR_DISCIPLINA,
      };
      await expect(service.create(IGREJA_ID, dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should auto-assign EXCLUIDOS for EXCLUSAO_POR_DISCIPLINA', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.DEMISSAO,
        motivacao_evento: MotivacaoEvento.EXCLUSAO_POR_DISCIPLINA,
      };
      await service.create(IGREJA_ID, dto as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rol: MembresiaRol.EXCLUIDOS }),
        }),
      );
    });

    it('should auto-assign ROL_SEPARADO for FALECIMENTO', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.DEMISSAO,
        motivacao_evento: MotivacaoEvento.FALECIMENTO,
      };
      await service.create(IGREJA_ID, dto as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rol: MembresiaRol.ROL_SEPARADO }),
        }),
      );
    });

    it('rejeita inclusão no mesmo dia sem sequência explícita', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.findMany.mockResolvedValue([{ rol: MembresiaRol.COMUNGANTES, data_evento: baseDto.data_evento, ordem_dia: null }]);
      await expect(service.create(IGREJA_ID, baseDto as any)).rejects.toThrow('ordem');
    });

    it('aceita ordem posterior ao último ato do mesmo dia', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.findMany.mockResolvedValue([{ rol: MembresiaRol.COMUNGANTES, data_evento: baseDto.data_evento, ordem_dia: 1 }]);
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      await service.create(IGREJA_ID, { ...baseDto, ordem_dia: 2 } as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ordem_dia: 2 }) }));
    });

    it('should reject EXCLUIDOS as rol for MUDANCA_DE_ROL', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.findMany.mockResolvedValue([{ rol: MembresiaRol.COMUNGANTES, data_evento: new Date('2024-01-01'), ordem_dia: null }]);
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.MUDANCA_DE_ROL,
        rol: MembresiaRol.EXCLUIDOS,
        motivacao_evento: MotivacaoEvento.PROFISSAO_DE_FE,
      };
      await expect(service.create(IGREJA_ID, dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should auto-fill rol_origem for MUDANCA_DE_ROL', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.findMany.mockResolvedValue([{ rol: MembresiaRol.NAO_COMUNGANTES, data_evento: new Date('2024-01-01'), ordem_dia: null }]);
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.MUDANCA_DE_ROL,
        rol: MembresiaRol.COMUNGANTES,
        motivacao_evento: MotivacaoEvento.PROFISSAO_DE_FE,
      };
      await service.create(IGREJA_ID, dto as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rol_origem: MembresiaRol.NAO_COMUNGANTES,
          }),
        }),
      );
    });

    it('should allow PARADEIRO_IGNORADO for MUDANCA_DE_ROL', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.findMany.mockResolvedValue([{ rol: MembresiaRol.COMUNGANTES, data_evento: new Date('2024-01-01'), ordem_dia: null }]);
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.MUDANCA_DE_ROL,
        rol: MembresiaRol.ROL_SEPARADO,
        motivacao_evento: MotivacaoEvento.PARADEIRO_IGNORADO,
      };
      await service.create(IGREJA_ID, dto as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should reject deleting non-last event', async () => {
      mockPrisma.eventos_membresia.findFirst.mockResolvedValueOnce({ id: 'old-event', pessoa_id: PESSOA_ID });
      mockPrisma.eventos_membresia.findMany.mockResolvedValue([{ id: 'newer-event', pessoa_id: PESSOA_ID, data_evento: new Date('2025-01-01'), ordem_dia: null }]);
      await expect(service.remove('old-event', IGREJA_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
