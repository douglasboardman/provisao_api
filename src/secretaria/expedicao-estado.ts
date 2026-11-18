import { NotFoundException } from '@nestjs/common';
import { featureEnabled } from '../feature-flags/feature-flags';
import { Tx } from './secretaria-base.service';

export function assinaturasDisponiveis() {
  return featureEnabled('secretaria') && featureEnabled('assinaturas');
}

export function exigirAssinaturas() {
  if (!assinaturasDisponiveis()) throw new NotFoundException('Recurso de assinaturas indisponível.');
}

export async function revogarConvites(tx: Tx, versaoId: string, arroladoId?: string) {
  await tx.convite_assinatura.updateMany({
    where: { versao_id: versaoId, arrolado_id: arroladoId, consumido_em: null, recusado_em: null, revogado_em: null },
    data: { revogado_em: new Date() },
  });
}

export async function cancelarExpedicao(tx: Tx, versaoId: string) {
  await tx.expedicao_documento.updateMany({
    where: { versao_id: versaoId, estado: { notIn: ['CONCLUIDA', 'CANCELADA'] } },
    data: { estado: 'CANCELADA', reserva_id: null, reserva_ate: null },
  });
  await revogarConvites(tx, versaoId);
}
