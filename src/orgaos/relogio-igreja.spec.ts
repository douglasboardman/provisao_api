import { dataCivilNoFuso } from './relogio-igreja';

describe('data civil por fuso', () => {
  it('separa as datas em torno da meia-noite UTC para igrejas em fusos distintos', () => {
    const instante = new Date('2026-11-17T01:30:00Z');
    expect(dataCivilNoFuso(instante, 'UTC')).toBe('2026-11-17');
    expect(dataCivilNoFuso(instante, 'America/Sao_Paulo')).toBe('2026-11-16');
    expect(dataCivilNoFuso(instante, 'Pacific/Kiritimati')).toBe('2026-11-17');
  });
  it('respeita transições históricas de horário de verão e rejeita fuso inválido', () => {
    expect(dataCivilNoFuso(new Date('2024-03-10T04:30:00Z'), 'America/New_York')).toBe('2024-03-09');
    expect(dataCivilNoFuso(new Date('2024-03-10T05:30:00Z'), 'America/New_York')).toBe('2024-03-10');
    expect(dataCivilNoFuso(new Date('2024-03-11T04:30:00Z'), 'America/New_York')).toBe('2024-03-11');
    expect(dataCivilNoFuso(new Date('2024-11-03T04:30:00Z'), 'America/New_York')).toBe('2024-11-03');
    expect(dataCivilNoFuso(new Date('2024-11-04T04:30:00Z'), 'America/New_York')).toBe('2024-11-03');
    expect(() => dataCivilNoFuso(new Date(), 'Fuso/Inexistente')).toThrow(RangeError);
  });
});
