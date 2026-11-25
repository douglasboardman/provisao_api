import { estadoDaLiberacao, exigirOperacaoDisponivel } from '../autorizacao/liberacao-servico';
import { Ator, contaDaSessao, decidirServico, Tx } from '../autorizacao/politica';
import { recursoDaIgreja } from '../feature-flags/feature-flags';

export async function permissaoMandato(tx: Tx, ator: Ator, emEscrita = false) {
  const igreja_id = ator.igreja_id;
  if (!recursoDaIgreja('governanca', igreja_id) || !recursoDaIgreja('orgaos', igreja_id) || !recursoDaIgreja('orgaos_gestao', igreja_id) || !recursoDaIgreja('secretaria', igreja_id)) return null;
  const liberacao = await estadoDaLiberacao(tx, igreja_id, 'MANDATOS_REGISTRAR', emEscrita);
  if (liberacao === 'PAUSADO' && !emEscrita) return null;
  exigirOperacaoDisponivel(liberacao);
  const conta = await contaDaSessao(tx, ator);
  if (!conta?.pessoa_id) return null;
  const decisao = await decidirServico(tx, conta, 'MANDATOS_REGISTRAR');
  return decisao.permite ? { pessoa: conta.pessoa_id, atribuicao: decisao.origem! } : null;
}
