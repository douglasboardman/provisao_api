import { Prisma } from '@prisma/client';
import { eventoVigente } from '../eventos-membresia/estado-temporal';

export const camposEventoRecepcao = {
  id: true,
  data_evento: true,
  ordem_dia: true,
  rol: true,
  rol_origem: true,
  tipo_evento: true,
  motivacao_evento: true,
} satisfies Prisma.eventos_membresiaSelect;

type Evento = Prisma.eventos_membresiaGetPayload<{ select: typeof camposEventoRecepcao }>;

/** Localiza o início do vínculo atual com a igreja a partir dos eventos documentados. */
export function recepcaoDaMembresia(eventos: Evento[], referencia: Date): Evento | undefined {
  const dias = new Map<number, Evento[]>();
  for (const evento of eventos) {
    const dia = evento.data_evento.getTime();
    if (dia > referencia.getTime()) continue;
    const grupo = dias.get(dia);
    if (grupo) grupo.push(evento);
    else dias.set(dia, [evento]);
  }

  const rolAtivo = (rol: Evento['rol_origem']) => rol === 'COMUNGANTES' || rol === 'NAO_COMUNGANTES';
  for (const dia of [...dias.keys()].sort((a, b) => b - a)) {
    const grupo = dias.get(dia)!;
    if (eventoVigente(grupo, new Date(dia)).situacao !== 'DEFINIDO') return;
    grupo.sort((a, b) => (b.ordem_dia ?? 0) - (a.ordem_dia ?? 0));
    for (const evento of grupo) {
      if (!rolAtivo(evento.rol)) return;
      if (evento.motivacao_evento === 'RESTAURACAO' ||
          (evento.tipo_evento === 'ADMISSAO' && !rolAtivo(evento.rol_origem))) {
        return evento;
      }
    }
  }
}
