import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateLancamentoDto } from './dto/create-lancamento.dto';
import { UpdateLancamentoDto } from './dto/update-lancamento.dto';

const INCLUDE_RELATIONS = { contas: true, receitas: true, despesas: true, pessoas: true, acoes: true } as const;

type LancamentoDetalhado = Prisma.lancamentosGetPayload<{ include: typeof INCLUDE_RELATIONS }>;
function isolarVinculos(l: LancamentoDetalhado) {
  const daIgreja = <T extends { igreja_id: string }>(r: T | null) => r?.igreja_id === l.igreja_id ? r : null;
  return { ...l, contas: daIgreja(l.contas), acoes: daIgreja(l.acoes), receitas: daIgreja(l.receitas),
    despesas: daIgreja(l.despesas), pessoas: daIgreja(l.pessoas) };
}

@Injectable()
export class LancamentosService {
  constructor(private readonly prisma: PrismaService) {}

  private async conferirVinculos(tx: Tx, igreja_id: string, dto: UpdateLancamentoDto) {
    const [conta, projeto, receita, despesa, pessoa] = await Promise.all([
      dto.conta_id && tx.contas.findFirst({ where: { id: dto.conta_id, igreja_id }, select: { id: true } }),
      dto.acao_id && tx.acoes.findFirst({ where: { id: dto.acao_id, igreja_id }, select: { id: true } }),
      dto.receita_id && tx.receitas.findFirst({ where: { id: dto.receita_id, igreja_id }, select: { id: true } }),
      dto.despesa_id && tx.despesas.findFirst({ where: { id: dto.despesa_id, igreja_id }, select: { id: true } }),
      dto.pessoa_id && tx.pessoas.findFirst({ where: { id: dto.pessoa_id, igreja_id }, select: { id: true } }),
    ]);
    if ([conta, projeto, receita, despesa, pessoa].includes(null)) {
      const verificados = [[dto.conta_id, conta], [dto.acao_id, projeto], [dto.receita_id, receita],
        [dto.despesa_id, despesa], [dto.pessoa_id, pessoa]];
      if (verificados.some(([id, cadastro]) => id && !cadastro)) throw new BadRequestException('Vínculo indisponível nesta igreja.');
    }
  }

  async create(igreja_id: string, usuario_id: string, dto: CreateLancamentoDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'LANCAMENTOS_REGISTRAR', async tx => {
      await this.conferirVinculos(tx, igreja_id, dto);
      return tx.lancamentos.create({
        data: { ...dto, igreja_id, usuario_id, data_transacao: new Date(dto.data_transacao) },
        include: INCLUDE_RELATIONS,
      });
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

    return { data: data.map(isolarVinculos), meta: { total, page, per_page, total_pages: Math.ceil(total / per_page) } };
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
      lancamentos: lancamentos.map(isolarVinculos),
    };
  }

  async findOne(id: string, igreja_id: string, tx: Tx = this.prisma) {
    const lancamento = await tx.lancamentos.findFirst({
      where: { id, igreja_id },
      include: INCLUDE_RELATIONS,
    });
    if (!lancamento) throw new NotFoundException(`Lançamento ${id} não encontrado.`);
    if (lancamento.igreja_id !== igreja_id) throw new ForbiddenException('Acesso negado.');
    return isolarVinculos(lancamento);
  }

  async update(id: string, igreja_id: string, dto: UpdateLancamentoDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'LANCAMENTOS_EDITAR', async tx => {
      await this.conferirVinculos(tx, igreja_id, dto);
      await this.findOne(id, igreja_id, tx);
      const data: any = { ...dto };
      if (dto.data_transacao) data.data_transacao = new Date(dto.data_transacao);
      return isolarVinculos(await tx.lancamentos.update({
        where: { id },
        data,
        include: INCLUDE_RELATIONS,
      }));
    });
  }

  async remove(id: string, igreja_id: string, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'LANCAMENTOS_EXCLUIR', async tx => {
      await this.findOne(id, igreja_id, tx);
      await tx.lancamentos.delete({ where: { id } });
      return { message: 'Lançamento removido com sucesso.' };
    });
  }
}
