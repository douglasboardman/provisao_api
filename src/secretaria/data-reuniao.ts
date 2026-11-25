import { camposHorarioReuniao, type horariosDaReuniao } from './horario-reuniao';
import { numeroPorExtenso } from '../core/numero-por-extenso';

const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const camposDataReuniao = ['dia_reuniao_por_extenso', 'mes_reuniao_por_extenso', 'ano_reuniao_por_extenso'] as const;
export const camposDataHoraReuniao = [...camposDataReuniao, ...camposHorarioReuniao] as const;
export type DataHoraReuniao = DataReuniaoPorExtenso & ReturnType<typeof horariosDaReuniao>;
export type DataReuniaoPorExtenso = Record<(typeof camposDataReuniao)[number], string>;

export function dataReuniaoPorExtenso(data: Date): DataReuniaoPorExtenso {
  const dia = data.getUTCDate();
  return {
    dia_reuniao_por_extenso: numeroPorExtenso(dia, dia === 1 ? 'ordinal' : 'cardinal'),
    mes_reuniao_por_extenso: meses[data.getUTCMonth()],
    ano_reuniao_por_extenso: numeroPorExtenso(data.getUTCFullYear()),
  };
}
