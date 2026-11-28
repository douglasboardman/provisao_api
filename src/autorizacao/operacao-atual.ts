import { ForbiddenException } from '@nestjs/common';
import { camposConta, decidirServico, type Conta, type Servico, type Tx } from './politica';
import { estadoDaLiberacao } from './liberacao-servico';

export async function podeServico(tx: Tx, conta: Conta, acao: Servico) {
  return await estadoDaLiberacao(tx, conta.igreja_id, acao) !== 'PAUSADO' && (await decidirServico(tx, conta, acao)).permite;
}
export async function exigirServicoDoUsuario(tx: Tx, igreja_id: string, id: string, acao: Servico) {
  if (await estadoDaLiberacao(tx, igreja_id, acao, true) === 'PAUSADO') throw new ForbiddenException('Esta operação está suspensa nesta igreja.');
  await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${id} AND igreja_id = ${igreja_id} FOR SHARE`;
  const conta = await tx.usuarios.findFirst({ where: { id, igreja_id, ativo: true }, select: camposConta });
  if (!conta || !await podeServico(tx, conta, acao)) throw new ForbiddenException('Atribuição vigente necessária nesta igreja.');
  const decisao = await decidirServico(tx, conta, acao);
  if (decisao.origem) {
    const vigentes = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM atribuicao_servico
      WHERE id = ${decisao.origem} AND igreja_id = ${igreja_id} AND usuario_id = ${id}
        AND geracao_vinculo = ${conta.geracao_vinculo} AND revogado_em IS NULL
        AND inicio <= clock_timestamp() AND (fim IS NULL OR fim > clock_timestamp()) FOR SHARE`;
    if (!vigentes.length || !(await decidirServico(tx, conta, acao)).permite)
      throw new ForbiddenException('A atribuição expirou ou foi revogada.');
  }
  return conta;
}
