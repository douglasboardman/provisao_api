type AtoDatado = { data_evento: Date; ordem_dia?: number | null };

function ordemDoDiaValida(eventos: AtoDatado[]) {
  if (eventos.length < 2) return true;
  const ordens = eventos.map(e => e.ordem_dia);
  return ordens.every(o => o != null && Number.isSafeInteger(o) && o > 0) && new Set(ordens).size === ordens.length;
}

export function sequenciaConferida(eventos: AtoDatado[]) {
  const dias = new Map<number, AtoDatado[]>();
  for (const evento of eventos) {
    const dia = evento.data_evento.getTime();
    const atos = dias.get(dia) ?? [];
    atos.push(evento);
    dias.set(dia, atos);
  }
  return [...dias.values()].every(ordemDoDiaValida);
}

/** Datas civis são inclusivas; só se decide a ordem de um dia com sequência completa. */
export function eventoVigente<T extends AtoDatado>(eventos: T[], data: Date):
  { situacao: 'SEM_EVENTO' } | { situacao: 'AMBIGUO' } | { situacao: 'DEFINIDO'; evento: T } {
  const vigentes = eventos.filter(e => e.data_evento.getTime() <= data.getTime());
  if (!vigentes.length) return { situacao: 'SEM_EVENTO' };
  const ultimoDia = vigentes.reduce((maior, evento) => Math.max(maior, evento.data_evento.getTime()), Number.NEGATIVE_INFINITY);
  const mesmoDia = vigentes.filter(e => e.data_evento.getTime() === ultimoDia);
  if (mesmoDia.length === 1) return { situacao: 'DEFINIDO', evento: mesmoDia[0] };
  if (!ordemDoDiaValida(mesmoDia)) return { situacao: 'AMBIGUO' };
  return { situacao: 'DEFINIDO', evento: mesmoDia.reduce((a, b) => a.ordem_dia! > b.ordem_dia! ? a : b) };
}
