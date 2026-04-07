import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuid } from 'uuid';

@Injectable()
export class StorageService {
  private readonly uploadsRoot = path.join(process.cwd(), 'uploads');

  async uploadFile(file: Express.Multer.File, folder: string): Promise<string> {
    const ext = path.extname(file.originalname) || this.extFromMime(file.mimetype);
    const filename = `${uuid()}${ext}`;
    const dir = path.join(this.uploadsRoot, folder);
    const filepath = path.join(dir, filename);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filepath, file.buffer);
      return `/uploads/${folder}/${filename}`;
    } catch (error) {
      console.error('Erro ao salvar arquivo local:', error);
      throw new InternalServerErrorException('Ocorreu um erro ao tentar salvar o arquivo.');
    }
  }

  private extFromMime(mimetype: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'application/pdf': '.pdf',
    };
    return map[mimetype] ?? '';
  }
}
