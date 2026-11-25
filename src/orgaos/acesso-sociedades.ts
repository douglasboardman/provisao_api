import { Conta, papeisDaConta, Tx } from '../autorizacao/politica';
import { avaliarExercicio } from '../oficiais/exercicio';
import { dataCivilOrgao } from './sociedades-regras';

export function periodoOrgao(data: Date) {
  return { inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] };
}

export async function presidenciaSociedades(tx: Tx, conta: Conta, dia: string) {
  if (!conta.conta_atuacao || !conta.pessoa_id || ['ADMINISTRADOR', 'AUDITOR'].includes(conta.perfil)) return null;
  const { presidencia_id } = await papeisDaConta(tx, conta, new Set(['PRESIDENCIA_CONSELHO']), dia);
  if (!presidencia_id) return null;
  const data = dataCivilOrgao(dia);
  const registro = await tx.presidencia_conselho.findFirst({ where: { id: presidencia_id, igreja_id: conta.igreja_id, oficial: { tipo: 'PRESBITERO_DOCENTE' } },
    select: { oficial: { select: { eventos: { where: { data_efeito: { lte: data } } },
      vinculos_pastorais: { where: { exercicio_institucional: true, data_inicio: { lte: data }, OR: [{ data_fim: null }, { data_fim: { gte: data } }] }, take: 2 },
    } } } });
  if (!registro || registro.oficial.vinculos_pastorais.length !== 1) return null;
  const [v] = registro.oficial.vinculos_pastorais;
  return avaliarExercicio({ data_posse: v.data_inicio, termino_previsto: data, termino_efetivo: v.data_fim }, registro.oficial.eventos, data).em_exercicio ? presidencia_id : null;
}

/** A lista nominal juvenil fica com o pastor responsável e com quem atua no próprio órgão. */
export async function orgaosDeAtuacao(tx: Tx, conta: Conta, dia: string) {
  if (!conta.conta_atuacao || !conta.pessoa_id || ['ADMINISTRADOR', 'AUDITOR'].includes(conta.perfil)) return [];
  const data = dataCivilOrgao(dia);
  const cargos = await tx.ocupacao_cargo.findMany({ where: { igreja_id: conta.igreja_id, pessoa_id: conta.pessoa_id,
    ...periodoOrgao(data), AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }],
    cargo: { ativo: true, orgao: { OR: [{ tipo: 'SOCIEDADE_INTERNA' }, { gestao_presidencial: true }] } } },
    distinct: ['orgao_id'], select: { orgao_id: true } });
  return cargos.map(c => c.orgao_id);
}

export async function orgaosJuvenisRestritos(tx: Tx, conta: Conta, dia: string) {
  const juvenis = await tx.orgao_interno.findMany({ where: { igreja_id: conta.igreja_id, tipo_padrao: { in: ['UCP', 'UPA'] } }, select: { id: true } });
  if (!juvenis.length || await presidenciaSociedades(tx, conta, dia)) return [];
  const permitidos = await orgaosDeAtuacao(tx, conta, dia);
  return juvenis.filter(o => !permitidos.includes(o.id)).map(o => o.id);
}

/** Ocupação em ficha oficial usa o mesmo exercício da Secretaria. */
export async function orgaosOficiaisDaConta(tx: Tx, conta: Conta, dia: string,
  atuacao: import('../secretaria/atuacao-modelo.service').AtuacaoModeloService) {
  if (!conta.conta_atuacao || !conta.pessoa_id || ['ADMINISTRADOR', 'AUDITOR'].includes(conta.perfil)) return [];
  const contextos = await tx.contexto_secretaria.findMany({ where: { igreja_id: conta.igreja_id,
    orgao: { ativo: true, tipo: { in: ['CONSELHO', 'JUNTA'] } } }, include: { orgao: true } });
  const acessos = await Promise.all(contextos.map(async contexto => ({
    id: contexto.orgao_id, acessivel: (await papeisDaConta(tx, conta, await atuacao.papeis(tx, contexto, conta.pessoa_id, dia), dia)).papeis.size > 0,
  })));
  return acessos.filter(v => v.acessivel).map(v => v.id);
}
