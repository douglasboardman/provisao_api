import { encerrarOcupacao, limiteExclusivoPorMeses, ocupacoesSobrepoem, validarPrazoCargo } from './regras-periodos';

describe('períodos de órgãos', () => {
  it('calcula meses civis com limite exclusivo e mês curto', () => {
    expect(limiteExclusivoPorMeses('2024-01-31', 1)).toBe('2024-02-29');
    expect(limiteExclusivoPorMeses('2024-02-29', 12)).toBe('2025-02-28');
    expect(limiteExclusivoPorMeses('2026-01-01', 240)).toBe('2046-01-01');
    expect(() => limiteExclusivoPorMeses('2026-01-01', 0)).toThrow();
  });
  it('limita Conselho a cinco anos e Junta a um ano civil de exercício', () => {
    expect(() => validarPrazoCargo('CONSELHO', '2026-01-01', '2030-12-31')).not.toThrow();
    expect(() => validarPrazoCargo('CONSELHO', '2026-01-01', '2031-01-01')).toThrow();
    expect(() => validarPrazoCargo('JUNTA', '2026-01-01', '2026-12-31')).not.toThrow();
    expect(() => validarPrazoCargo('JUNTA', '2026-01-01', '2030-12-31')).toThrow();
  });

  it('valida datas e aniversário de início em dia bissexto', () => {
    expect(() => validarPrazoCargo('JUNTA', '2024-02-29', '2025-02-27')).not.toThrow();
    expect(() => validarPrazoCargo('JUNTA', '2024-02-29', '2025-02-28')).toThrow();
    expect(() => validarPrazoCargo('JUNTA', '2026-02-30', '2026-03-01')).toThrow();
  });

  it('permite sucessão na data efetiva e detecta conflito com ocupação aberta', () => {
    const anterior = encerrarOcupacao({ inicio: '2026-01-01', fim: null }, '2026-06-01');
    expect(ocupacoesSobrepoem(anterior, { inicio: '2026-06-01', fim: null })).toBe(false);
    expect(ocupacoesSobrepoem({ inicio: '2026-01-01', fim: null }, { inicio: '2026-06-01', fim: null })).toBe(true);
    expect(() => encerrarOcupacao(anterior, '2026-07-01')).toThrow();
    expect(() => encerrarOcupacao({ inicio: '2026-01-01', fim: null }, '2026-01-01')).toThrow();
  });
});
