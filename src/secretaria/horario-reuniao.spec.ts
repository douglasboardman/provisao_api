import { horariosDaReuniao } from './horario-reuniao';

describe('Horários de reunião', () => {
  it.each([
    ['00:00', 'meia-noite'], ['01:01', 'uma hora e um minuto'], ['02:02', 'duas horas e dois minutos'],
    ['12:00', 'doze horas'], ['21:22', 'vinte e uma horas e vinte e dois minutos'],
  ])('formata %s com o deslocamento informado quando a igreja não tem fuso', (hora, extenso) => {
    expect(horariosDaReuniao('2026-11-22T' + hora + ':00-04:00', null)).toEqual({
      horario_inicio_reuniao: hora, horario_inicio_reuniao_por_extenso: extenso,
      horario_encerramento_reuniao: null, horario_encerramento_reuniao_por_extenso: null,
    });
  });

  it('usa o fuso da igreja ao atravessar a meia-noite em UTC', () => {
    expect(horariosDaReuniao(null, '2026-11-23T00:00:00Z', 'America/Manaus')).toEqual({
      horario_inicio_reuniao: null, horario_inicio_reuniao_por_extenso: null,
      horario_encerramento_reuniao: '20:00', horario_encerramento_reuniao_por_extenso: 'vinte horas',
    });
  });
});
