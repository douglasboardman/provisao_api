import { ForbiddenException } from '@nestjs/common';
import { exigirServicoNaTransacao } from '../autorizacao/escrita-servico';
import { estadoDaLiberacao, exigirOperacaoDisponivel } from '../autorizacao/liberacao-servico';
import { camposConta, contaDaSessao, decidirServico, type Ator, type Servico, type Tx } from '../autorizacao/politica';

export async function exigirServicoHistorico(tx: Tx, igreja_id: string, usuario: string, acao: Servico,
  escrita: boolean, ator?: Ator) {
  const estado = await estadoDaLiberacao(tx, igreja_id, acao, escrita);
  exigirOperacaoDisponivel(estado);
  const conta = await tx.usuarios.findFirst({ where: { id: usuario, igreja_id, ativo: true }, select: camposConta });
  if (!conta) throw new ForbiddenException('Operador não autorizado nesta igreja.');
  if (estado === 'ATRIBUICAO' || conta.perfil === 'COMUM') {
    if (!ator || ator.sub !== usuario || ator.igreja_id !== igreja_id)
      throw new ForbiddenException('Sessão indisponível para esta operação.');
    if (escrita) {
      await exigirServicoNaTransacao(tx, ator, acao);
    } else if (!(await decidirServico(tx, await contaDaSessao(tx, ator), acao)).permite) {
      throw new ForbiddenException('Atribuição vigente necessária.');
    }
    return;
  }
  const perfis = ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO', ...(!escrita ? ['AUDITOR'] : [])];
  if (!perfis.includes(conta.perfil)) throw new ForbiddenException('Operador não autorizado nesta igreja.');
}
