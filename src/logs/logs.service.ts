import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma, logs_atividades_acao } from '@prisma/client';

interface RegistrarDto {
  igreja_id: string;
  usuario_id: string;
  acao: logs_atividades_acao;
  tabela_afetada: string;
  registro_id?: string | null;
  ip_address?: string;
  dados_novos?: Record<string, unknown>;
}

@Injectable()
export class LogsService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(data: RegistrarDto): Promise<void> {
    try {
      await this.prisma.logs_atividades.create({
        data: {
          igreja_id: data.igreja_id,
          usuario_id: data.usuario_id,
          acao: data.acao,
          tabela_afetada: data.tabela_afetada,
          registro_id: data.registro_id ?? null,
          ip_address: data.ip_address ?? null,
          dados_novos: (data.dados_novos as Prisma.InputJsonValue) ?? undefined,
        },
      });
    } catch {
      // Logging failures must never surface to the caller
    }
  }

  async findAll(igreja_id: string, page = 1) {
    const take = 50;
    const skip = (page - 1) * take;
    // O log geral é acessível a vários perfis; detalhes e existência de atos
    // sensíveis só devem ser consultados pelo fluxo com concessão específica.
    const where: Prisma.logs_atividadesWhereInput = { igreja_id, NOT: [
      { tabela_afetada: { in: ['secretaria', 'documento', 'comando_secretaria', 'anexo_documento_consulta', 'evento_oficial', 'acesso_eventos_sensiveis', 'eventos_sensiveis_consulta', 'mandato_oficial', 'vinculo_pastoral', 'registro_historico_oficial', 'acervo_historico_consulta', 'decisao_revisao_eleitoral', 'revisao_eleitoral_consulta', 'insercao_retroativa_oficial', 'previa_insercao_oficial', 'correcao_data_membresia', 'previa_correcao_membresia', 'correcao_conteudo_membresia', 'previa_correcao_conteudo', 'insercao_retroativa_membresia', 'previa_insercao_retroativa', 'ordenacao_membresia', 'previa_ordenacao_membresia', 'referencia_identidade_pastoral', 'convite_identidade_pastoral', 'oficiais'] } },
    ] };
    const [data, total] = await Promise.all([
      this.prisma.logs_atividades.findMany({
        where, skip, take,
        orderBy: { created_at: 'desc' },
        include: { usuarios: { select: { nome_usuario: true, email_login: true } } },
      }),
      this.prisma.logs_atividades.count({ where }),
    ]);
    const serialized = data.map((log) => ({ ...log, id: String(log.id) }));
    return { data: serialized, total, page, totalPages: Math.ceil(total / take) };
  }
}
