import { ForbiddenException, GoneException, SetMetadata } from '@nestjs/common';
import { gruposServico, servicosDeHistorico, type Servico } from './catalogo-servicos';
import type { Tx } from './politica';

export const servicosLiberaveis = [
  ...Object.values(gruposServico.pessoas), ...Object.values(gruposServico['grupos-familiares']),
  ...Object.values(gruposServico['eventos-membresia']), ...Object.values(gruposServico.lancamentos),
  ...Object.values(gruposServico.acoes), ...Object.values(gruposServico.contas),
  ...Object.values(gruposServico['cat-receita']), ...Object.values(gruposServico['cat-despesa']),
  ...Object.values(gruposServico.receitas), ...Object.values(gruposServico.despesas),
  ...Object.values(gruposServico['autorizacoes-financeiras']),
  ...Object.values(gruposServico['solicitacoes-acesso']),
  'VINCULOS_DOCUMENTAIS_CONSULTAR', 'VINCULOS_DOCUMENTAIS_REGISTRAR',
  ...servicosDeHistorico,
  ...Object.values(gruposServico['balanco-mensal']), ...Object.values(gruposServico.logs), 'MANDATOS_REGISTRAR',
] as const satisfies readonly Servico[];

export type ServicoLiberavel = (typeof servicosLiberaveis)[number];
export type EstadoLiberacao = 'LEGADO' | 'ATRIBUICAO' | 'PAUSADO';
const liberaveis = new Set<Servico>(servicosLiberaveis);
export const RotaLegadaDe = (acao: ServicoLiberavel) => SetMetadata('rota_legada_de', acao);

export async function estadoDaLiberacao(tx: Tx, igreja_id: string, acao: Servico, emEscrita = false): Promise<EstadoLiberacao> {
  if (!liberaveis.has(acao)) return 'LEGADO';
  if (emEscrita) await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igreja_id} FOR SHARE`;
  const escolha = await tx.liberacao_servico.findUnique({ where: { igreja_id_acao: { igreja_id, acao } }, select: { estado: true } });
  if (!escolha) return 'LEGADO';
  return escolha.estado === 'ATRIBUICAO' ? 'ATRIBUICAO' : 'PAUSADO';
}

export function exigirOperacaoDisponivel(estado: EstadoLiberacao) {
  if (estado === 'PAUSADO') throw new ForbiddenException('Esta operação está suspensa nesta igreja.');
}

export function exigirRotaLegada(estado: EstadoLiberacao) {
  exigirOperacaoDisponivel(estado);
  if (estado === 'ATRIBUICAO') throw new GoneException('Use o registro de mandato pela ficha do Conselho ou da Junta.');
}
