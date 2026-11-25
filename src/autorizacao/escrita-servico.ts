import { estadoDaLiberacao, exigirOperacaoDisponivel } from './liberacao-servico';
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { contaDaSessao, decidirServico, type Ator, type Servico, type Tx } from './politica';

/** Preserva a autorização durante a gravação, inclusive contra revogação,
 * conversão da conta ou troca da identidade por outra transação. */
export async function exigirServicoNaTransacao(tx: Tx, ator: Ator | undefined, acao: Servico) {
  if (!ator) return;
  const estado = await estadoDaLiberacao(tx, ator.igreja_id, acao, true);
  exigirOperacaoDisponivel(estado);
  await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${ator.sub} AND igreja_id = ${ator.igreja_id} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM sessoes WHERE id = ${ator.sessao_id} AND usuario_id = ${ator.sub} FOR SHARE`;
  const conta = await contaDaSessao(tx, ator);
  if (estado === 'LEGADO' && conta.perfil !== 'COMUM') return;
  const decisao = await decidirServico(tx, conta, acao);
  if (!decisao.permite || !decisao.origem) throw new ForbiddenException('Atribuição vigente necessária.');
  const vigente = await tx.$queryRaw<{ id: string; concessao_modelo_id: string | null }[]>`
    SELECT id, concessao_modelo_id FROM atribuicao_servico
    WHERE id = ${decisao.origem} AND igreja_id = ${ator.igreja_id} AND revogado_em IS NULL
      AND inicio <= clock_timestamp() AND (fim IS NULL OR fim > clock_timestamp())
    FOR SHARE
  `;
  if (!vigente.length) throw new ForbiddenException('A atribuição expirou ou foi revogada.');
  if (vigente[0].concessao_modelo_id && (await decidirServico(tx, conta, acao)).origem !== vigente[0].id)
    throw new ForbiddenException('O mandato ou cargo exigido pela atribuição está indisponível.');
}

export function gravarPorServico<T>(prisma: PrismaService, ator: Ator | undefined, acao: Servico, gravar: (tx: Tx) => Promise<T>) {
  if (!ator) return gravar(prisma);
  return prisma.$transaction(async tx => {
    await exigirServicoNaTransacao(tx, ator, acao);
    return gravar(tx);
  });
}
