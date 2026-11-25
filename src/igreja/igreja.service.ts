import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
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

    return this.prisma.$transaction(async tx => {
      const igreja = await tx.igreja.create({ data: dto });
      await tx.$executeRaw`SELECT instalar_estrutura_institucional(${igreja.id})`;
      return igreja;
    });
  }

  async findAllPublic(): Promise<Pick<igreja, 'id' | 'nome'>[]> {
    return this.prisma.igreja.findMany({
      where: { ativa: true },
      select: { id: true, nome: true },
      orderBy: { nome: 'asc' },
    });
  }

  async findMe(igreja_id: string, tx: Tx = this.prisma): Promise<igreja> {
    const record = await tx.igreja.findUnique({ where: { id: igreja_id } });
    if (!record) throw new NotFoundException('Igreja não encontrada.');
    return record;
  }

  async updateMe(igreja_id: string, dto: UpdateIgrejaDto, ator?: Ator): Promise<igreja> {
    return gravarPorServico(this.prisma, ator, 'IGREJA_EDITAR', async tx => {
      await this.findMe(igreja_id, tx);

      if (dto.cnpj) {
        const existing = await tx.igreja.findUnique({ where: { cnpj: dto.cnpj } });
        if (existing && existing.id !== igreja_id) {
          throw new ConflictException('Este CNPJ já está cadastrado.');
        }
      }

      return tx.igreja.update({ where: { id: igreja_id }, data: dto });
    });
  }

  async updateLogo(igreja_id: string, file: Express.Multer.File, ator?: Ator): Promise<igreja> {
    return gravarPorServico(this.prisma, ator, 'IGREJA_EDITAR', async tx => {
      await this.findMe(igreja_id, tx);
      const url_logo = await this.storageService.uploadFile(file, 'church-logos');
      return tx.igreja.update({ where: { id: igreja_id }, data: { url_logo } });
    });
  }

  async findCongregacoes(igreja_id: string): Promise<igreja[]> {
    return this.prisma.igreja.findMany({ where: { vinculada_a: igreja_id } });
  }
}
