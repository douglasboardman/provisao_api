import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateLancamentoDto } from './dto/create-lancamento.dto';
import { UpdateLancamentoDto } from './dto/update-lancamento.dto';

@Injectable()
export class LancamentosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(igreja_id: string, usuario_id: string, dto: CreateLancamentoDto) {
    return this.prisma.lancamentos.create({
      data: { ...dto, igreja_id, usuario_id, data_transacao: new Date(dto.data_transacao) },
      include: { contas: true, receitas: true, despesas: true, pessoas: true, acoes: true },
    });
  }

  async findAll(igreja_id: string, params?: { tipo?: string; conta_id?: string; page?: number }) {
    const page = params?.page ?? 1;
    const take = 20;
    const skip = (page - 1) * take;
    const where: any = { igreja_id };
    if (params?.tipo) where.tipo_transacao = params.tipo;
    if (params?.conta_id) where.conta_id = params.conta_id;

    const [data, total] = await Promise.all([
      this.prisma.lancamentos.findMany({
        where, skip, take,
        orderBy: [{ data_transacao: 'desc' }, { created_at: 'desc' }],
        include: { contas: true, receitas: true, despesas: true, pessoas: true, acoes: true },
      }),
      this.prisma.lancamentos.count({ where }),
    ]);
    return { data, total, page, totalPages: Math.ceil(total / take) };
  }

  async findOne(id: string, igreja_id: string) {
    const lancamento = await this.prisma.lancamentos.findFirst({
      where: { id, igreja_id },
      include: { contas: true, receitas: true, despesas: true, pessoas: true, acoes: true },
    });
    if (!lancamento) throw new NotFoundException(`Lançamento ${id} não encontrado.`);
    if (lancamento.igreja_id !== igreja_id) throw new ForbiddenException('Acesso negado.');
    return lancamento;
  }

  async update(id: string, igreja_id: string, dto: UpdateLancamentoDto) {
    await this.findOne(id, igreja_id);
    const data: any = { ...dto };
    if (dto.data_transacao) data.data_transacao = new Date(dto.data_transacao);
    return this.prisma.lancamentos.update({
      where: { id },
      data,
      include: { contas: true, receitas: true, despesas: true, pessoas: true, acoes: true },
    });
  }

  async remove(id: string, igreja_id: string) {
    await this.findOne(id, igreja_id);
    await this.prisma.lancamentos.delete({ where: { id } });
    return { message: 'Lançamento removido com sucesso.' };
  }
}
