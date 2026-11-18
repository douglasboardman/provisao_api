import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const tiposOrdenados = ['DESIGNACAO', 'DISPENSA', 'PARTICIPACAO_INCLUSAO', 'PARTICIPACAO_SAIDA', 'ELEICAO_CARGO', 'ENCERRAMENTO_CARGO', 'ELEICAO_CARGO_UNIDADE', 'ENCERRAMENTO_CARGO_UNIDADE', 'DESATIVACAO'];

/** Chamador mantém o bloqueio do órgão. Pedidos antigos sem ordem usam a próxima
 * sequência, atribuída sob esse mesmo bloqueio. Pedidos novos podem informá-la. */
export async function ordemDoAto(tx: Prisma.TransactionClient, igreja: string, orgao: string, data: Date, informada?: number) {
  const atos = await tx.ato_orgao.findMany({ where: { igreja_id: igreja, orgao_id: orgao, data_efeito: data, tipo: { in: tiposOrdenados } }, select: { detalhes: true } });
  const ordens = atos.map(a => a.detalhes && typeof a.detalhes === 'object' && !Array.isArray(a.detalhes) ? a.detalhes.ordem_efeito : undefined);
  // Atos legados sem ordem terminam no limite civil 1. Não se inventa uma ordem
  // entre eles, mas atos novos podem ocorrer depois desse bloco histórico.
  const ultima = Math.max(0, ...ordens.map(o => typeof o === 'number' ? o : 1));
  const ordem = informada ?? ultima + 1;
  if (!Number.isInteger(ordem) || ordem <= ultima || ordem > 9999) throw new BadRequestException('Ordem já ocupada; atualize a sequência dos atos.');
  return ordem;
}
