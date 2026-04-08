import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retorna todos os KPIs consolidados para o dashboard da igreja.
   * Utiliza Promise.all para paralelizar as queries e minimizar latência.
   *
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async getResumo(igreja_id: string) {
    const now = new Date();
    const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
    const fimMes = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const [
      receitasMes,
      despesasMes,
      saldoContas,
      totalMembrosAtivos,
      totalCongregados,
      acoesCount,
      ultimosLancamentos,
    ] = await Promise.all([
      // Total de RECEITAS do mês corrente
      this.prisma.lancamentos.aggregate({
        where: {
          igreja_id,
          tipo_transacao: 'RECEITA',
          data_transacao: { gte: inicioMes, lte: fimMes },
        },
        _sum: { valor: true },
      }),

      // Total de DESPESAS do mês corrente
      this.prisma.lancamentos.aggregate({
        where: {
          igreja_id,
          tipo_transacao: 'DESPESA',
          data_transacao: { gte: inicioMes, lte: fimMes },
        },
        _sum: { valor: true },
      }),

      // Saldo consolidado: soma de saldo_inicial de todas as contas + saldo de lançamentos
      this.prisma.contas.aggregate({
        where: { igreja_id },
        _sum: { saldo_inicial: true },
      }),

      // Membros comungantes ativos
      this.prisma.vinculos_membresia.count({
        where: { igreja_id, vinculo_ativo: true, rol: 'COMUNGANTE' },
      }),

      // Congregados (não-comungantes) ativos
      this.prisma.vinculos_membresia.count({
        where: { 
          igreja_id, 
          vinculo_ativo: true, 
          rol: { notIn: ['COMUNGANTE'] },
        },
      }),

      // Ações em andamento (sem data_fim ou data_fim >= hoje)
      this.prisma.acoes.count({
        where: {
          igreja_id,
          OR: [{ data_fim: null }, { data_fim: { gte: now } }],
        },
      }),

      // Últimos 5 lançamentos
      this.prisma.lancamentos.findMany({
        where: { igreja_id },
        orderBy: [{ data_transacao: 'desc' }, { created_at: 'desc' }],
        take: 5,
        include: {
          contas: { select: { descricao: true } },
          receitas: { select: { nome: true } },
          despesas: { select: { nome: true } },
        },
      }),
    ]);

    // Saldo total consolidado = saldo_inicial das contas + receitas - despesas (all time)
    const totalReceitas = await this.prisma.lancamentos.aggregate({
      where: { igreja_id, tipo_transacao: 'RECEITA' },
      _sum: { valor: true },
    });
    const totalDespesas = await this.prisma.lancamentos.aggregate({
      where: { igreja_id, tipo_transacao: 'DESPESA' },
      _sum: { valor: true },
    });

    const saldoInicial = Number(saldoContas._sum.saldo_inicial ?? 0);
    const totalReceitasAllTime = Number(totalReceitas._sum.valor ?? 0);
    const totalDespesasAllTime = Number(totalDespesas._sum.valor ?? 0);
    const saldoConsolidado = saldoInicial + totalReceitasAllTime - totalDespesasAllTime;

    return {
      financeiro: {
        receitas_mes: Number(receitasMes._sum.valor ?? 0),
        despesas_mes: Number(despesasMes._sum.valor ?? 0),
        saldo_consolidado: saldoConsolidado,
      },
      membresia: {
        comungantes_ativos: totalMembrosAtivos,
        congregados_ativos: totalCongregados,
      },
      acoes_em_andamento: acoesCount,
      ultimos_lancamentos: ultimosLancamentos,
    };
  }
}
