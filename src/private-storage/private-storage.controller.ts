import { BadRequestException, Controller, Get, Param, Post, Request, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AuthGuard } from 'src/auth/auth.guard';
import { PrivateStorageService } from './private-storage.service';

@Controller('arquivos-privados')
@UseGuards(AuthGuard)
export class PrivateStorageController {
  constructor(private readonly storage: PrivateStorageService) {}
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  upload(@Request() req, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Arquivo obrigatório.');
    return this.storage.save(req.user, file.buffer);
  }
  @Get(':id')
  async download(@Request() req, @Param('id') id: string, @Res() res: Response) {
    const data = await this.storage.read(req.user, id);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="arquivo.bin"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(data);
  }
}
