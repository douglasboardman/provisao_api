import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateTratamentoDto } from './dto/create-tratamento.dto';
import { UpdateTratamentoDto } from './dto/update-tratamento.dto';
import { tratamentos } from '@prisma/client';

@Injectable()
export class TratamentosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTratamentoDto): Promise<tratamentos> {
    return this.prisma.tratamentos.create({ data: dto });
  }

  async findAll(): Promise<tratamentos[]> {
    return this.prisma.tratamentos.findMany({ orderBy: { descricao: 'asc' } });
  }

  async findOne(id: number): Promise<tratamentos> {
    const tratamento = await this.prisma.tratamentos.findUnique({ where: { id } });
    if (!tratamento) {
      throw new NotFoundException(`Tratamento com ID ${id} não encontrado.`);
    }
    return tratamento;
  }

  async update(id: number, dto: UpdateTratamentoDto): Promise<tratamentos> {
    await this.findOne(id);
    return this.prisma.tratamentos.update({ where: { id }, data: dto });
  }

  async remove(id: number): Promise<{ message: string }> {
    await this.findOne(id);
    await this.prisma.tratamentos.delete({ where: { id } });
    return { message: `Tratamento com ID ${id} removido com sucesso.` };
  }
}
