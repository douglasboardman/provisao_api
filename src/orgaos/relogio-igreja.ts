/** Converte um instante para data civil sem depender do fuso do processo. */
export function dataCivilNoFuso(instante: Date, fuso: string): string {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instante);
  const obter = (tipo: Intl.DateTimeFormatPartTypes) => partes.find(p => p.type === tipo)?.value;
  const ano = obter('year'), mes = obter('month'), dia = obter('day');
  if (!ano || !mes || !dia) throw new RangeError('Data civil não pôde ser apurada.');
  return `${ano.padStart(4, '0')}-${mes}-${dia}`;
}
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';


/** Deve ser chamado depois de bloquear o usuário e antes de outras chaves de ato. */
export async function hojeDaIgreja(tx: Prisma.TransactionClient, igreja: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${igreja + ':fuso-orgao'}, 0))`;
  // A alteração do fuso atualiza a versão desta linha. Em Serializable, um
  // snapshot anterior ao bloqueio falha e a transação é tentada novamente.
  await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igreja} FOR SHARE`;
  const config = await tx.configuracao_fuso_igreja.findUnique({ where: { igreja_id: igreja }, select: { fuso_iana: true } });
  try { return dataCivilNoFuso(new Date(), config?.fuso_iana ?? 'UTC'); }
  catch { throw new BadRequestException('Fuso da igreja inválido; confira a configuração.'); }
}
