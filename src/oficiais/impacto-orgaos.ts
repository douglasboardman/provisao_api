import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { featureEnabled } from '../feature-flags/feature-flags';
import { eventoVigente } from '../eventos-membresia/estado-temporal';

export type DetalheVinculoOrgao = { id: string; inicio: string; tipo: 'PARTICIPACAO' | 'OCUPACAO'; orgao: string; cargo: string | null; comparacao_rol: 'ALTERADO' | 'PRESERVADO' | 'INDETERMINADO' };
type EventoRol = { data_evento: Date; ordem_dia: number | null; rol: string };

/** Não existe ordem compartilhada entre os eventos de membresia e o ato do órgão. */
export function compararRolNoInicio(antes: EventoRol[], depois: EventoRol[], inicio: Date): 'ALTERADO' | 'PRESERVADO' | 'INDETERMINADO' {
  if ([...antes, ...depois].some(e => e.data_evento.getTime() === inicio.getTime())) return 'INDETERMINADO';
  const anterior = eventoVigente(antes, inicio), projetado = eventoVigente(depois, inicio);
  if (anterior.situacao !== 'DEFINIDO' || projetado.situacao !== 'DEFINIDO') return 'INDETERMINADO';
  return anterior.evento.rol === projetado.evento.rol ? 'PRESERVADO' : 'ALTERADO';
}

/** Indexa dias uma vez; mantém as mesmas regras de eventoVigente, inclusive ambiguidades. */
export function criarComparadorRol(antes: EventoRol[], depois: EventoRol[]) {
  function indexar(eventos: EventoRol[]) {
    const grupos = new Map<number, EventoRol[]>();
    for (const evento of eventos) {
      const dia = evento.data_evento.getTime();
      const grupo = grupos.get(dia) ?? [];
      grupo.push(evento);
      grupos.set(dia, grupo);
    }
    const dias = [...grupos.keys()].sort((a, b) => a - b);
    const estados = dias.map(dia => eventoVigente(grupos.get(dia)!, new Date(dia)));
    return { dias, estados, datas: new Set(dias) };
  }
  const anterior = indexar(antes), projetado = indexar(depois);
  function vigente(indice: ReturnType<typeof indexar>, dia: number) {
    let inicio = 0, fim = indice.dias.length;
    while (inicio < fim) {
      const meio = Math.floor((inicio + fim) / 2);
      if (indice.dias[meio] < dia) inicio = meio + 1;
      else fim = meio;
    }
    return inicio === 0 ? undefined : indice.estados[inicio - 1];
  }
  return (inicio: Date): 'ALTERADO' | 'PRESERVADO' | 'INDETERMINADO' => {
    const dia = inicio.getTime();
    if (anterior.datas.has(dia) || projetado.datas.has(dia)) return 'INDETERMINADO';
    const a = vigente(anterior, dia), b = vigente(projetado, dia);
    if (a?.situacao !== 'DEFINIDO' || b?.situacao !== 'DEFINIDO') return 'INDETERMINADO';
    return a.evento.rol === b.evento.rol ? 'PRESERVADO' : 'ALTERADO';
  };
}

/** Espelha o bloqueio conservador da E03; não decide se houve impacto real. */
export async function impactoOrgaos(tx: Prisma.TransactionClient, igreja: string, pessoa: string, data: Date, alteraBase = true, comparacao?: { antes: EventoRol[]; depois: EventoRol[] }, coletar?: (detalhes: DetalheVinculoOrgao[]) => void) {
  if (!featureEnabled('orgaos') || !alteraBase) return undefined;
  const [participacoes, ocupacoes] = await Promise.all([
    tx.membro_orgao.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, inicio: { gte: data } }, select: { id: true, inicio: true, orgao: { select: { nome: true } } }, orderBy: { id: 'asc' } }),
    tx.ocupacao_cargo.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, inicio: { gte: data } }, select: { id: true, inicio: true, cargo: { select: { nome: true, orgao: { select: { nome: true } } } } }, orderBy: { id: 'asc' } }),
  ]);
  if (!participacoes.length && !ocupacoes.length) return undefined;
  const vinculos = [
    ...participacoes.map(v => ({ id: v.id, inicio: v.inicio, tipo: 'PARTICIPACAO' as const, orgao: v.orgao.nome, cargo: null })),
    ...ocupacoes.map(v => ({ id: v.id, inicio: v.inicio, tipo: 'OCUPACAO' as const, orgao: v.cargo.orgao.nome, cargo: v.cargo.nome })),
  ].sort((a, b) => a.inicio.getTime() - b.inicio.getTime() || a.id.localeCompare(b.id));
  const comparar = comparacao ? criarComparadorRol(comparacao.antes, comparacao.depois) : undefined;
  const detalhes = comparar ? vinculos.map(v => ({ ...v, inicio: v.inicio.toISOString().slice(0, 10), comparacao_rol: comparar(v.inicio) })) : [];
  if (comparacao && coletar) coletar(detalhes);
  return {
    bloqueia: participacoes.length + ocupacoes.length > 0,
    participacoes: participacoes.length,
    ocupacoes: ocupacoes.length,
    ...(comparacao ? { rol_alterado: detalhes.filter(v => v.comparacao_rol === 'ALTERADO').length, rol_preservado: detalhes.filter(v => v.comparacao_rol === 'PRESERVADO').length, rol_indeterminado: detalhes.filter(v => v.comparacao_rol === 'INDETERMINADO').length, detalhes: detalhes.slice(0, 100), detalhes_limitados: detalhes.length > 100 } : {}),
    assinatura: createHash('sha256').update(JSON.stringify(vinculos.map(v => ({ id: v.id, inicio: v.inicio, tipo: v.tipo })))).digest('hex'),
  };
}
