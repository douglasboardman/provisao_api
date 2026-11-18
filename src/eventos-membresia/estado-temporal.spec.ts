import { eventoVigente } from './estado-temporal';
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
describe('membresia em data civil', () => {
  it('ignora eventos futuros e inclui o dia consultado', () => {
    const eventos = [{ data_evento: d('2026-01-01'), ordem_dia: null, rol: 'COMUNGANTES' }, { data_evento: d('2027-01-01'), ordem_dia: 1, rol: 'EXCLUIDOS' }];
    expect(eventoVigente(eventos, d('2026-01-01'))).toEqual({ situacao: 'DEFINIDO', evento: eventos[0] });
    expect(eventoVigente(eventos, d('2025-12-31')).situacao).toBe('SEM_EVENTO');
  });
  it('aceita sequência explícita e recusa grupos parcialmente ordenados ou duplicados', () => {
    const a = { data_evento: d('2026-01-01'), ordem_dia: 1, rol: 'NAO_COMUNGANTES' }, b = { data_evento: d('2026-01-01'), ordem_dia: 2, rol: 'COMUNGANTES' };
    expect(eventoVigente([b, a], d('2026-01-01'))).toEqual({ situacao: 'DEFINIDO', evento: b });
    expect(eventoVigente([a, { ...b, ordem_dia: null }], d('2026-01-01')).situacao).toBe('AMBIGUO');
    expect(eventoVigente([a, { ...b, ordem_dia: 1 }], d('2026-01-01')).situacao).toBe('AMBIGUO');
  });
});
