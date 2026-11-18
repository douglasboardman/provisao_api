import { oficial_evento_tipo } from '@prisma/client';

type Evento = { id: string; tipo: oficial_evento_tipo; data_efeito: Date; ordem: number; evento_restaurado_id: string | null };
type Periodo = { data_posse: Date; termino_previsto: Date; termino_efetivo: Date | null };

/** As datas de posse e término são inclusivas; restauração não cria mandato. */
export function avaliarExercicio(periodo: Periodo, eventos: Evento[], data: Date) {
  const dia = data.getTime();
  const fim = (periodo.termino_efetivo ?? periodo.termino_previsto).getTime();
  if (dia < periodo.data_posse.getTime()) return { em_exercicio: false, motivo: 'MANDATO_NAO_INICIADO' as const };
  if (dia > fim) return { em_exercicio: false, motivo: 'MANDATO_ENCERRADO' as const };
  const ordenados = eventos.filter(e => e.data_efeito.getTime() <= dia)
    .slice().sort((a, b) => a.data_efeito.getTime() - b.data_efeito.getTime() || a.ordem - b.ordem);
  if (!ordenados.some(e => e.tipo === 'ORDENACAO')) return { em_exercicio: false, motivo: 'ORDENACAO_NAO_DOCUMENTADA' as const };
  const impedimentos = new Map<string, oficial_evento_tipo>();
  let ordemAnterior = '';
  for (const evento of ordenados) {
    const chaveOrdem = `${evento.data_efeito.getTime()}:${evento.ordem}`;
    if (chaveOrdem === ordemAnterior) return { em_exercicio: false, motivo: 'HISTORICO_INCONSISTENTE' as const };
    ordemAnterior = chaveOrdem;
    if (evento.tipo === 'ORDENACAO') continue;
    if (evento.tipo === 'RESTAURACAO') {
      if (!evento.evento_restaurado_id || !impedimentos.delete(evento.evento_restaurado_id)) {
        return { em_exercicio: false, motivo: 'HISTORICO_INCONSISTENTE' as const };
      }
    } else {
      impedimentos.set(evento.id, evento.tipo);
    }
  }
  const impedimento = impedimentos.values().next().value as oficial_evento_tipo | undefined;
  return impedimento ? { em_exercicio: false, motivo: impedimento } : { em_exercicio: true, motivo: 'EM_EXERCICIO' as const };
}
