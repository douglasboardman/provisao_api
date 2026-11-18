import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
type Tx = Prisma.TransactionClient;
/** A decisão só é consumida na mesma transação da correção e sempre vinculada ao hash. */
export async function consumirDecisaoEleitoral(tx: Tx, igreja: string, pessoa: string, operacao: string, hash: string, decisaoId: string | undefined, impacto: { conferencias: Array<Record<string, unknown>>; mandatos: Array<Record<string, unknown>> }) {
  if (!decisaoId) throw new ConflictException('A correção exige decisão formal da autoridade competente e revisão eleitoral.');
  await tx.$queryRaw`SELECT id FROM decisao_revisao_eleitoral WHERE id = ${decisaoId} AND igreja_id = ${igreja} FOR UPDATE`;
  const decisao = await tx.decisao_revisao_eleitoral.findFirst({ where: { id: decisaoId, igreja_id: igreja, pessoa_id: pessoa, operacao, hash_previa: hash } });
  if (!decisao || decisao.aplicado_em) throw new ConflictException('Decisão inexistente, já utilizada ou incompatível com a prévia.');
  const conferencias = impacto.conferencias.filter(c => c.evento_corrigido_utilizado === true || c.evento_antes !== undefined && c.evento_antes !== c.evento_depois || c.rol_antes !== undefined && c.rol_antes !== c.rol_depois).map(c => String(c.id));
  const mandatos = impacto.mandatos.filter(m => m.rol_eleicao_antes !== m.rol_eleicao_depois || m.rol_posse_antes !== m.rol_posse_depois).map(m => String(m.id));
  const conferenciasUnicas = [...new Set(conferencias)];
  if (conferenciasUnicas.length) {
    const relacionados = await tx.mandato_oficial.findMany({ where: { igreja_id: igreja, oficial: { pessoa_id: pessoa }, conferencia_id: { in: conferenciasUnicas } }, select: { id: true } });
    mandatos.push(...relacionados.map(m => m.id));
  }
  const mandatosUnicos = [...new Set(mandatos)];
  if (!conferenciasUnicas.length && !mandatosUnicos.length) throw new ConflictException('Não há ato eleitoral identificado para revisão.');
  const [qtdConferencias, qtdMandatos] = await Promise.all([
    tx.conferencia_eleicao_oficial.count({ where: { igreja_id: igreja, pessoa_id: pessoa, id: { in: conferenciasUnicas } } }),
    tx.mandato_oficial.count({ where: { igreja_id: igreja, oficial: { pessoa_id: pessoa }, id: { in: mandatosUnicos } } }),
  ]);
  if (qtdConferencias !== conferenciasUnicas.length || qtdMandatos !== mandatosUnicos.length) throw new ConflictException('Atos afetados mudaram; gere nova prévia.');
  await tx.revisao_eleitoral_item.createMany({ data: [...conferenciasUnicas.map(conferencia_id => ({ igreja_id: igreja, decisao_id: decisao.id, conferencia_id })), ...mandatosUnicos.map(mandato_id => ({ igreja_id: igreja, decisao_id: decisao.id, mandato_id }))] });
  await tx.decisao_revisao_eleitoral.update({ where: { id: decisao.id }, data: { aplicado_em: new Date() } });
}
