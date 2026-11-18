import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { logs_atividades_acao } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { hashAto, registrarRequisicao, requisicaoAnterior, transacaoSerializavel } from './idempotencia';

const entrada = z.object({ fuso_iana: z.string().trim().min(1).max(100), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();

@Injectable()
export class FusoIgrejaService {
  constructor(private readonly prisma: PrismaService) {}

  async consultar(igreja: string) {
    const atual = await this.prisma.configuracao_fuso_igreja.findUnique({ where: { igreja_id: igreja }, select: { fuso_iana: true, atualizado_em: true } });
    return { configuracao: atual, em_uso_pelos_orgaos: true };
  }

  async registrar(igreja: string, usuario: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Configuração de fuso inválida.');
    const { idempotencia: chave, ...v } = parsed.data;
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: v.fuso_iana }).format(new Date()); }
    catch { throw new BadRequestException('Fuso horário IANA inválido.'); }
    const contexto = { igreja, usuario, idempotencia: chave.toLowerCase(), tipo: 'FUSO_IGREJA', hash: hashAto({ operacao: 'FUSO_IGREJA', dados: v }) };
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuario} AND igreja_id = ${igreja} FOR UPDATE`;
      if (!await tx.usuarios.findFirst({ where: { id: usuario, igreja_id: igreja, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } })) throw new ForbiddenException('Operador não autorizado.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':fuso-orgao'}, 0))`;
      const repetida = await requisicaoAnterior(tx, contexto);
      if (repetida) {
        if (repetida.id !== igreja || typeof repetida.fuso_iana !== 'string') throw new BadRequestException('Resultado anterior indisponível.');
        return { id: igreja, fuso_iana: repetida.fuso_iana };
      }
      await tx.$executeRaw`UPDATE igreja SET updated_at = updated_at WHERE id = ${igreja}`;
      const anterior = await tx.configuracao_fuso_igreja.findUnique({ where: { igreja_id: igreja }, select: { fuso_iana: true } });
      await tx.configuracao_fuso_igreja.upsert({ where: { igreja_id: igreja }, create: { igreja_id: igreja, fuso_iana: v.fuso_iana }, update: { fuso_iana: v.fuso_iana } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: anterior ? logs_atividades_acao.ATUALIZACAO : logs_atividades_acao.CRIACAO, tabela_afetada: 'configuracao_fuso_igreja', registro_id: igreja, dados_antigos: anterior ?? undefined, dados_novos: { fuso_iana: v.fuso_iana, autoridade: v.autoridade, evidencia: v.evidencia } } });
      const resposta = { id: igreja, fuso_iana: v.fuso_iana };
      await registrarRequisicao(tx, contexto, resposta);
      return resposta;
    });
  }
}
