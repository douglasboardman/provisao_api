import { numeroPorExtenso } from '../core/numero-por-extenso';

export const camposHorarioReuniao = [
  'horario_inicio_reuniao', 'horario_inicio_reuniao_por_extenso',
  'horario_encerramento_reuniao', 'horario_encerramento_reuniao_por_extenso',
] as const;

function formatarHorario(instante: unknown, fuso?: string) {
  if (typeof instante !== 'string' || !Number.isFinite(Date.parse(instante))) return null;
  const horario = fuso
    ? new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(instante))
    : instante.slice(11, 16);
  return { horario, extenso: horarioCivilPorExtenso(horario) };
}

export function horarioCivilPorExtenso(horario?: string) {
  if (!horario) return null;
  const [hora, minuto] = horario.split(':').map(Number);
  const horas = hora === 0 ? 'meia-noite' : numeroPorExtenso(hora, 'cardinal', 'feminino') + (hora === 1 ? ' hora' : ' horas');
  const minutos = minuto ? ' e ' + numeroPorExtenso(minuto) + (minuto === 1 ? ' minuto' : ' minutos') : '';
  return horas + minutos;
}

export function horariosDaReuniao(inicio: unknown, fim: unknown, fuso?: string) {
  const abertura = formatarHorario(inicio, fuso);
  const encerramento = formatarHorario(fim, fuso);
  return {
    horario_inicio_reuniao: abertura?.horario ?? null,
    horario_inicio_reuniao_por_extenso: abertura?.extenso ?? null,
    horario_encerramento_reuniao: encerramento?.horario ?? null,
    horario_encerramento_reuniao_por_extenso: encerramento?.extenso ?? null,
  };
}
