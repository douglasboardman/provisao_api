import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { createHash } from 'crypto';
import { DetalheVinculoOrgao } from '../oficiais/impacto-orgaos';
import { featureEnabled } from '../feature-flags/feature-flags';
import { hojeDaIgreja } from './relogio-igreja';

/** Revisão integral na própria transação da correção. Preserva a decisão sobre o
 * ato passado; não concede elegibilidade atual nem encerra vínculos por inferência. */
export async function revisarOrgaosNaAplicacao(tx: Prisma.TransactionClient, igreja: string, usuario: string, pessoa: string, operacao: string, previa: { hash: string; bloqueio_orgao?: { bloqueia: boolean; participacoes: number; ocupacoes: number } }, detalhes: DetalheVinculoOrgao[], ids?: string[]) {
  if (!previa.bloqueio_orgao?.bloqueia) {
    if (ids?.length) throw new ConflictException('Esta prévia não exige revisão dos vínculos de órgão.');
    return null;
  }
  if (ids?.length && !featureEnabled('orgaos_gestao')) throw new ForbiddenException('Gestão de órgãos indisponível para aplicar a revisão.');
  if (!ids?.length || new Set(ids).size !== ids.length) throw new ConflictException('A alteração exige revisão dos vínculos de órgão. Selecione decisões favoráveis com cobertura integral.');
  if (detalhes.length !== previa.bloqueio_orgao.participacoes + previa.bloqueio_orgao.ocupacoes) throw new ConflictException('A revisão não cobre todos os vínculos de órgão.');
  await tx.$queryRaw`SELECT id FROM decisao_revisao_orgao WHERE igreja_id = ${igreja} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
  const decisoes = await tx.decisao_revisao_orgao.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, id: { in: ids }, hash_previa: previa.hash, operacao }, orderBy: { id: 'asc' } });
  if (decisoes.length !== ids.length || decisoes.some(d => d.resultado !== 'FAVORAVEL')) throw new ConflictException('Decisão ausente, contrária ou incompatível com a prévia atual.');
  const atuais = new Set(detalhes.map(d => `${d.tipo}:${d.id}`)), cobertos = new Set<string>();
  const hashDetalhes = createHash('sha256').update(JSON.stringify(detalhes)).digest('hex');
  const schema = z.array(z.object({ tipo: z.enum(['PARTICIPACAO', 'OCUPACAO']), id: z.uuid(), observacao: z.string().trim().min(1), encaminhamento: z.enum(['PRESERVAR', 'REVISAR', 'INDETERMINADO']).optional() }).strict());
  for (const d of decisoes) {
    const anotacoes = schema.safeParse(d.anotacoes_vinculos);
    const impacto = d.impacto as Prisma.JsonObject;
    if (!anotacoes.success || (impacto.hash_detalhes_anotados && impacto.hash_detalhes_anotados !== hashDetalhes)) throw new ConflictException('A revisão exige encaminhamento de preservação justificado para todos os vínculos; resolva revisões adicionais e indeterminações antes de aplicar.');
    for (const a of anotacoes.data) {
      const chave = `${a.tipo}:${a.id}`;
      if (!atuais.has(chave)) throw new ConflictException('Há vínculo estranho ou desatualizado na decisão.');
      if (a.encaminhamento && a.encaminhamento !== 'PRESERVAR') throw new ConflictException('Resolva revisões adicionais e indeterminações antes de aplicar.');
      if (a.encaminhamento === 'PRESERVAR') cobertos.add(chave);
    }
  }
  if (cobertos.size !== atuais.size) throw new ConflictException('A revisão não cobre todos os vínculos de órgão.');
  const membros = detalhes.filter(d => d.tipo === 'PARTICIPACAO').map(d => d.id), ocupacoes = detalhes.filter(d => d.tipo === 'OCUPACAO').map(d => d.id);
  const [participacoes, cargos] = await Promise.all([
    tx.membro_orgao.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, id: { in: membros } }, select: { orgao_id: true } }),
    tx.ocupacao_cargo.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, id: { in: ocupacoes } }, select: { cargo: { select: { orgao: { select: { tipo: true } } } } } }),
  ]);
  if (participacoes.length !== membros.length || cargos.length !== ocupacoes.length) throw new ConflictException('Os vínculos de órgão mudaram.');
  let competenciaId: string | null = null;
  if (participacoes.length || cargos.some(c => c.cargo.orgao.tipo === 'UNIDADE_MINISTERIAL')) {
    const operador = await tx.usuarios.findFirst({ where: { id: usuario, igreja_id: igreja, ativo: true, perfil: 'GESTOR' }, select: { pessoa_id: true } });
    const hoje = new Date(`${await hojeDaIgreja(tx, igreja)}T00:00:00Z`);
    const competencia = operador?.pessoa_id ? await tx.competencia_unidades.findFirst({ where: { igreja_id: igreja, usuario_id: usuario, pessoa_id: operador.pessoa_id, inicio: { lte: hoje }, OR: [{ fim: null }, { fim: { gt: hoje } }] }, select: { id: true } }) : null;
    if (!competencia) throw new ForbiddenException('A aplicação da revisão de unidades exige gestor com competência institucional vigente.');
    competenciaId = competencia.id;
  }
  return { operador_id: usuario, competencia_id: competenciaId, hash_previa: previa.hash, hash_detalhes: hashDetalhes, decisoes: decisoes.map(d => ({ id: d.id, autoridade: d.autoridade, evidencia: d.evidencia, justificativa: d.justificativa, anotacoes: d.anotacoes_vinculos })), vinculos: detalhes, conferido_em: new Date().toISOString() } as Prisma.InputJsonObject;
}
