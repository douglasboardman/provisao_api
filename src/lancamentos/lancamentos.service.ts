import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateLancamentoDto } from './dto/create-lancamento.dto';
import { UpdateLancamentoDto } from './dto/update-lancamento.dto';

const INCLUDE_RELATIONS = { contas: true, receitas: true, despesas: true, pessoas: true, acoes: true } as const;

@Injectable()
export class LancamentosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(igreja_id: string, usuario_id: string, dto: CreateLancamentoDto) {
    return this.prisma.lancamentos.create({
      data: { ...dto, igreja_id, usuario_id, data_transacao: new Date(dto.data_transacao) },
      include: INCLUDE_RELATIONS,
    });
  }

  async findAll(
    igreja_id: string,
    params?: { tipo?: string; conta_id?: string; page?: number; mes?: number; ano?: number },
  ) {
    const page = params?.page ?? 1;
    const per_page = 20;
    const skip = (page - 1) * per_page;
    const where: any = { igreja_id };

    if (params?.tipo) where.tipo_transacao = params.tipo;
    if (params?.conta_id) where.conta_id = params.conta_id;
    if (params?.mes !== undefined && params?.ano !== undefined) {
      const inicio = new Date(params.ano, params.mes - 1, 1);
      const fim = new Date(params.ano, params.mes, 0);
      where.data_transacao = { gte: inicio, lte: fim };
    }

    const [data, total] = await Promise.all([
      this.prisma.lancamentos.findMany({
        where, skip, take: per_page,
        orderBy: [{ data_transacao: 'desc' }, { created_at: 'desc' }],
        include: INCLUDE_RELATIONS,
      }),
      this.prisma.lancamentos.count({ where }),
    ]);

    return { data, meta: { total, page, per_page, total_pages: Math.ceil(total / per_page) } };
  }

  async balanco(igreja_id: string, mes: number, ano: number) {
    const inicio = new Date(ano, mes - 1, 1);
    const fim = new Date(ano, mes, 0);
    const where = { igreja_id, data_transacao: { gte: inicio, lte: fim } };

    const lancamentos = await this.prisma.lancamentos.findMany({
      where,
      orderBy: [{ data_transacao: 'desc' }, { created_at: 'desc' }],
      include: INCLUDE_RELATIONS,
    });

    let total_receitas = 0;
    let total_despesas = 0;
    for (const l of lancamentos) {
      const valor = Number(l.valor);
      if (l.tipo_transacao === 'RECEITA') total_receitas += valor;
      else total_despesas += valor;
    }

    return {
      mes,
      ano,
      total_receitas: +total_receitas.toFixed(2),
      total_despesas: +total_despesas.toFixed(2),
      saldo: +(total_receitas - total_despesas).toFixed(2),
      lancamentos,
    };
  }

  async findOne(id: string, igreja_id: string) {
    const lancamento = await this.prisma.lancamentos.findFirst({
      where: { id, igreja_id },
      include: INCLUDE_RELATIONS,
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
      include: INCLUDE_RELATIONS,
    });
  }

  async remove(id: string, igreja_id: string) {
    await this.findOne(id, igreja_id);
    await this.prisma.lancamentos.delete({ where: { id } });
    return { message: 'Lançamento removido com sucesso.' };
  }
}
