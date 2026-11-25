import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';

import { codigosServico, servicosDeConsulta, servicosDeHistorico, type Servico } from './catalogo-servicos';
import { filtrarAtribuicoesDeModelos } from './validade-modelo';

export type { Servico } from './catalogo-servicos';
export const servicos = z.enum(codigosServico);
export type Ator = { sub: string; igreja_id: string; auth_version: number; sessao_id: string; perfil?: usuarios_perfil };
export type Tx = Prisma.TransactionClient;
export const camposConta = { id: true, igreja_id: true, perfil: true, pessoa_id: true, ativo: true,
  auth_version: true, conta_atuacao: true, geracao_vinculo: true } as const;
export type Conta = Prisma.usuariosGetPayload<{ select: typeof camposConta }>;
export const ContaComum = () => SetMetadata('aceita_conta_comum', true);
export const ObservarServico = (acao: Servico) => SetMetadata('servico_em_comparacao', acao);
export const ServicoEmContexto = (acao: Servico) => SetMetadata('servico_em_contexto', acao);
export const ServicoDaRota = (acao: Servico) => SetMetadata('servico_da_rota', acao);
export const fundamento = z.string().trim().min(1).max(1000);

export async function contaDaSessao(tx: Tx, a: Ator) {
  const sessao = await tx.sessoes.findFirst({ where: { id: a.sessao_id, usuario_id: a.sub, auth_version: a.auth_version,
    revogada_em: null, expira_em: { gt: new Date() }, usuario: { igreja_id: a.igreja_id, auth_version: a.auth_version, ativo: true } },
    select: { usuario: { select: { ...camposConta, igreja: { select: { mfa_obrigatorio: true } }, mfa_reinscricao_obrigatoria: true,
      mfa_credencial: { select: { estado: true } } } } } });
  const conta = sessao?.usuario;
  if (conta && (conta.mfa_reinscricao_obrigatoria || (conta.perfil === 'ADMINISTRADOR' && conta.igreja.mfa_obrigatorio)) &&
      conta.mfa_credencial?.estado !== 'ATIVO') throw new ForbiddenException('Conclua a verificação de MFA.');
  if (!conta || (a.perfil && conta.perfil !== a.perfil)) throw new ForbiddenException('Conta indisponível.');
  return conta;
}


export function compativel(perfil: usuarios_perfil, acao: Servico) {
  if (acao === 'ACESSO_CONSULTAR' || acao === 'ACESSO_ANALISAR')
    return ['ADMINISTRADOR', 'GESTOR', 'COMUM'].includes(perfil);
  if ((servicosDeHistorico as readonly Servico[]).includes(acao))
    return ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO', 'COMUM'].includes(perfil) ||
      perfil === 'AUDITOR' && servicosDeConsulta.has(acao);
  if (acao === 'MANDATOS_REGISTRAR' || acao === 'CARGOS_REGISTRAR') return perfil === 'COMUM' || perfil === 'GESTOR' || perfil === 'SECRETARIO';
  if (acao === 'PRESIDENCIA_CONFERIR') return perfil === 'ADMINISTRADOR';
  return perfil !== 'AUDITOR' || servicosDeConsulta.has(acao);
}

export async function decidirServico(tx: Tx, conta: Conta, acao: Servico, agora = new Date()) {
  if (!conta.ativo || !compativel(conta.perfil, acao)) return { permite: false, motivo: 'CONTA_INCOMPATIVEL' };
  const registros = await tx.atribuicao_servico.findMany({ where: { igreja_id: conta.igreja_id, usuario_id: conta.id, acao },
    select: { id: true, geracao_vinculo: true, inicio: true, fim: true, revogado_em: true, concessao_modelo_id: true }, orderBy: { inicio: 'desc' } });
  return decisaoAtribuicoes(conta, acao, await filtrarAtribuicoesDeModelos(tx, conta, registros, agora), agora);
}

export function decisaoAtribuicoes(conta: Conta, acao: Servico, registros: {
  id: string; geracao_vinculo: number; inicio: Date; fim: Date | null; revogado_em: Date | null;
}[], agora: Date): { permite: boolean; motivo: string; origem?: string } {
  if (!conta.ativo || !compativel(conta.perfil, acao)) return { permite: false, motivo: 'CONTA_INCOMPATIVEL' };
  const vigente = registros.find(r => r.geracao_vinculo === conta.geracao_vinculo && !r.revogado_em &&
    r.inicio <= agora && (!r.fim || agora < r.fim));
  if (vigente) return { permite: true, motivo: 'ATRIBUICAO_VIGENTE', origem: vigente.id };
  const ultima = registros.find(r => r.geracao_vinculo === conta.geracao_vinculo) ?? registros[0];
  if (!ultima) return { permite: false, motivo: 'SEM_ATRIBUICAO' };
  const motivo = ultima.geracao_vinculo !== conta.geracao_vinculo ? 'VINCULO_ALTERADO' : ultima.revogado_em ? 'ATRIBUICAO_REVOGADA'
    : ultima.inicio > agora ? 'ATRIBUICAO_FUTURA' : 'ATRIBUICAO_EXPIRADA';
  return { permite: false, motivo, origem: ultima.id };
}

export async function comparar(tx: Tx, conta: Conta, acao: string, recurso: string, legado: boolean,
  proposta: { permite: boolean; motivo: string; origem?: string }, origemLegada: string, operador = conta) {
  if (legado === proposta.permite) return;
  await tx.evento_autorizacao.create({ data: { igreja_id: conta.igreja_id, operador_id: operador.id,
    operador_pessoa_id: operador.pessoa_id, destinatario_id: conta.id, pessoa_id: conta.pessoa_id,
    acao: 'DIVERGENCIA', recurso_id: recurso, fundamento: proposta.motivo,
    dados: { acao, perfil: conta.perfil, legado, proposta: proposta.permite, origem_legada: origemLegada,
      origem_proposta: proposta.origem ?? null } } });
}

export async function papeisDaConta(tx: Tx, conta: Conta, papeis: Set<string>, dia: string) {
  if (!conta.ativo || !conta.pessoa_id || !conta.conta_atuacao || ['ADMINISTRADOR','AUDITOR'].includes(conta.perfil))
    return { papeis: new Set<string>(), motivo: 'SEM_CONTA_DE_ATUACAO', presidencia_id: null };
  const validos = new Set(papeis);
  let presidencia_id: string | null = null;
  if (validos.has('PRESIDENCIA_CONSELHO')) {
    const data = new Date(dia);
    const p = await tx.presidencia_conselho.findFirst({ where: { igreja_id: conta.igreja_id, oficial: { pessoa_id: conta.pessoa_id },
      inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] }, select: { id: true } });
    if (p && await tx.evento_autorizacao.findFirst({ where: { igreja_id: conta.igreja_id, pessoa_id: conta.pessoa_id,
      recurso_id: p.id, acao: 'PRESIDENCIA_CONFERIDA' }, select: { id: true } })) presidencia_id = p.id;
    else validos.delete('PRESIDENCIA_CONSELHO');
  }
  const motivo = validos.size ? 'CARGO_EM_EXERCICIO' : papeis.has('PRESIDENCIA_CONSELHO') ? 'PRESIDENCIA_SEM_CONFERENCIA' : 'SEM_CARGO_VIGENTE';
  return { papeis: validos, motivo, presidencia_id };
}

export function decidirAcaoModelo(acao: 'criar' | 'preparar', regra: { criar: string[]; preparar: string[] } | undefined,
  atuacao: Awaited<ReturnType<typeof papeisDaConta>>) {
  if (!regra) return { permite: false, motivo: 'MODELO_SEM_REGRA_PUBLICADA' };
  const cargo = regra[acao].find(id => atuacao.papeis.has(id));
  if (!cargo) return { permite: false, motivo: atuacao.papeis.size ? 'MODELO_SEM_CARGO_HABILITADO' : atuacao.motivo };
  return { permite: true, motivo: 'CARGO_HABILITADO_NO_MODELO', origem: cargo === 'PRESIDENCIA_CONSELHO' ? atuacao.presidencia_id! : cargo };
}
