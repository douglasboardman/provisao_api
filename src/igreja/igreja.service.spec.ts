import { Test } from '@nestjs/testing';
import { IgrejaService } from './igreja.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { StorageService } from 'src/storage/storage.service';
import { ConflictException, NotFoundException } from '@nestjs/common';

const mockIgreja = {
  id: 'church-1',
  nome: 'Igreja Teste',
  cnpj: null,
  congregacao: false,
  vinculada_a: null,
  url_logo: null,
  cep: null,
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cidade: null,
  estado: null,
  ativa: true,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('IgrejaService', () => {
  let service: IgrejaService;
  let prisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    igreja: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let storage: { uploadFile: jest.Mock };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(fn => fn(prisma)),
      $executeRaw: jest.fn(),
      igreja: {
        findUnique: jest.fn().mockResolvedValue(mockIgreja),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(mockIgreja),
        update: jest.fn().mockResolvedValue(mockIgreja),
      },
    };
    storage = { uploadFile: jest.fn().mockResolvedValue('/uploads/church-logos/abc.jpg') };

    const module = await Test.createTestingModule({
      providers: [
        IgrejaService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(IgrejaService);
  });

  // ── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('cria uma igreja sem CNPJ nem vinculada_a', async () => {
      prisma.igreja.create.mockResolvedValue({ ...mockIgreja, nome: 'Nova Igreja' });
      const result = await service.create({ nome: 'Nova Igreja', congregacao: false });
      expect(prisma.igreja.create).toHaveBeenCalled();
      expect(result.nome).toBe('Nova Igreja');
    });

    it('lança ConflictException se CNPJ já cadastrado', async () => {
      prisma.igreja.findUnique.mockResolvedValue({ ...mockIgreja, cnpj: '12345678000100' });
      await expect(
        service.create({ nome: 'X', congregacao: false, cnpj: '12345678000100' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.igreja.create).not.toHaveBeenCalled();
    });

    it('lança NotFoundException se vinculada_a não existe', async () => {
      prisma.igreja.findUnique.mockResolvedValue(null);
      await expect(
        service.create({ nome: 'Congregação', congregacao: true, vinculada_a: 'missing-id' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.igreja.create).not.toHaveBeenCalled();
    });
  });

  // ── findMe ────────────────────────────────────────────────────────────────

  describe('findMe', () => {
    it('retorna a igreja', async () => {
      const result = await service.findMe('church-1');
      expect(result.id).toBe('church-1');
    });

    it('lança NotFoundException se não encontrada', async () => {
      prisma.igreja.findUnique.mockResolvedValue(null);
      await expect(service.findMe('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateMe ──────────────────────────────────────────────────────────────

  describe('updateMe', () => {
    it('atualiza a igreja', async () => {
      const updated = { ...mockIgreja, nome: 'Novo Nome' };
      prisma.igreja.update.mockResolvedValue(updated);
      const result = await service.updateMe('church-1', { nome: 'Novo Nome' });
      expect(prisma.igreja.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'church-1' } }),
      );
      expect(result.nome).toBe('Novo Nome');
    });

    it('lança ConflictException se CNPJ já usado por outra igreja', async () => {
      prisma.igreja.findUnique
        .mockResolvedValueOnce(mockIgreja)               // findMe → exists
        .mockResolvedValueOnce({ id: 'other-church' });  // CNPJ check → conflict
      await expect(
        service.updateMe('church-1', { cnpj: '12345678000100' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.igreja.update).not.toHaveBeenCalled();
    });

    it('não lança ConflictException se CNPJ pertence à própria igreja', async () => {
      prisma.igreja.findUnique
        .mockResolvedValueOnce(mockIgreja)                               // findMe
        .mockResolvedValueOnce({ ...mockIgreja, cnpj: '12345678000100' }); // CNPJ → same id
      await expect(
        service.updateMe('church-1', { cnpj: '12345678000100' }),
      ).resolves.not.toThrow();
    });
  });

  // ── updateLogo ────────────────────────────────────────────────────────────

  describe('updateLogo', () => {
    it('chama StorageService e atualiza url_logo', async () => {
      const file = { originalname: 'logo.jpg' } as Express.Multer.File;
      const updated = { ...mockIgreja, url_logo: '/uploads/church-logos/abc.jpg' };
      prisma.igreja.update.mockResolvedValue(updated);

      const result = await service.updateLogo('church-1', file);

      expect(storage.uploadFile).toHaveBeenCalledWith(file, 'church-logos');
      expect(prisma.igreja.update).toHaveBeenCalledWith({
        where: { id: 'church-1' },
        data: { url_logo: '/uploads/church-logos/abc.jpg' },
      });
      expect(result.url_logo).toBe('/uploads/church-logos/abc.jpg');
    });
  });

  // ── findCongregacoes ──────────────────────────────────────────────────────

  describe('findCongregacoes', () => {
    it('retorna lista de congregações vinculadas', async () => {
      const congregacao = { ...mockIgreja, id: 'cong-1', vinculada_a: 'church-1' };
      prisma.igreja.findMany.mockResolvedValue([congregacao]);
      const result = await service.findCongregacoes('church-1');
      expect(prisma.igreja.findMany).toHaveBeenCalledWith({
        where: { vinculada_a: 'church-1' },
      });
      expect(result).toHaveLength(1);
    });

    it('retorna lista vazia quando não há congregações', async () => {
      const result = await service.findCongregacoes('church-1');
      expect(result).toHaveLength(0);
    });
  });
});
