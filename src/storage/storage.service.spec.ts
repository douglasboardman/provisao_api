import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import * as fs from 'fs/promises';

jest.mock('fs/promises');

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StorageService],
    }).compile();
    service = module.get<StorageService>(StorageService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('uploadFile deve retornar path /uploads/{folder}/{uuid}.{ext}', async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    const mockFile = {
      buffer: Buffer.from('test'),
      originalname: 'foto.jpg',
      mimetype: 'image/jpeg',
    } as Express.Multer.File;

    const result = await service.uploadFile(mockFile, 'fotos-pessoas');

    expect(result).toMatch(/^\/uploads\/fotos-pessoas\/.+\.jpg$/);
    expect(fs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('fotos-pessoas'),
      { recursive: true },
    );
    expect(fs.writeFile).toHaveBeenCalled();
  });
});
