import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { StorageService } from 'src/storage/storage.service';
import { CreateIgrejaDto } from './dto/create-igreja.dto';
import { UpdateIgrejaDto } from './dto/update-igreja.dto';
import { igreja } from '@prisma/client';

@Injectable()
export class IgrejaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  async create(dto: CreateIgrejaDto): Promise<igreja> {
    if (dto.cnpj) {
      const existing = await this.prisma.igreja.findUnique({ where: { cnpj: dto.cnpj } });
      if (existing) throw new ConflictException('Este CNPJ já está cadastrado.');
    }

    if (dto.vinculada_a) {
      const matriz = await this.prisma.igreja.findUnique({ where: { id: dto.vinculada_a } });
      if (!matriz) throw new NotFoundException('Igreja matriz não encontrada.');
    }

    return this.prisma.igreja.create({ data: dto });
  }

  async findAllPublic(): Promise<Pick<igreja, 'id' | 'nome'>[]> {
    return this.prisma.igreja.findMany({
      where: { ativa: true },
      select: { id: true, nome: true },
      orderBy: { nome: 'asc' },
    });
  }

  async findMe(igreja_id: string): Promise<igreja> {
    const record = await this.prisma.igreja.findUnique({ where: { id: igreja_id } });
    if (!record) throw new NotFoundException('Igreja não encontrada.');
    return record;
  }

  async updateMe(igreja_id: string, dto: UpdateIgrejaDto): Promise<igreja> {
    await this.findMe(igreja_id);

    if (dto.cnpj) {
      const existing = await this.prisma.igreja.findUnique({ where: { cnpj: dto.cnpj } });
      if (existing && existing.id !== igreja_id) {
        throw new ConflictException('Este CNPJ já está cadastrado.');
      }
    }

    return this.prisma.igreja.update({ where: { id: igreja_id }, data: dto });
  }

  async updateLogo(igreja_id: string, file: Express.Multer.File): Promise<igreja> {
    await this.findMe(igreja_id);
    const url_logo = await this.storageService.uploadFile(file, 'church-logos');
    return this.prisma.igreja.update({ where: { id: igreja_id }, data: { url_logo } });
  }

  async findCongregacoes(igreja_id: string): Promise<igreja[]> {
    return this.prisma.igreja.findMany({ where: { vinculada_a: igreja_id } });
  }
}
