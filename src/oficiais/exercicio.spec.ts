import { avaliarExercicio } from './exercicio';
import { oficial_evento_tipo as Tipo } from '@prisma/client';
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const periodo = { data_posse: d('2025-01-01'), termino_previsto: d('2029-12-31'), termino_efetivo: null };
const evento = (id: string, tipo: Tipo, data: string, ordem = 1, restaurado: string | null = null) => ({ id, tipo, data_efeito: d(data), ordem, evento_restaurado_id: restaurado });
const ordenacao = evento('ord', Tipo.ORDENACAO, '2024-01-01');
describe('exercício de oficial', () => {
  it('respeita limites inclusivos e não depende de alertas', () => {
    expect(avaliarExercicio(periodo, [], d('2024-12-31')).em_exercicio).toBe(false);
    expect(avaliarExercicio(periodo, [ordenacao], d('2029-12-31')).em_exercicio).toBe(true);
    expect(avaliarExercicio(periodo, [], d('2030-01-01')).em_exercicio).toBe(false);
  });
  it('não presume ordenação a partir do mandato', () => {
    expect(avaliarExercicio(periodo, [], d('2026-01-01')).motivo).toBe('ORDENACAO_NAO_DOCUMENTADA');
  });
  it('ordena atos do mesmo dia, restaura o afastamento indicado e ignora atos futuros', () => {
    const atos = [ordenacao, evento('r', Tipo.RESTAURACAO, '2026-01-01', 2, 's'), evento('s', Tipo.SUSPENSAO, '2026-01-01', 1), evento('d', Tipo.DEPOSICAO, '2027-01-01')];
    expect(avaliarExercicio(periodo, atos, d('2026-01-01')).em_exercicio).toBe(true);
    expect(avaliarExercicio(periodo, atos, d('2027-01-01')).motivo).toBe('DEPOSICAO');
  });
  it('mantém outros afastamentos e detecta restauração sem alvo anterior', () => {
    const atos = [ordenacao, evento('s', Tipo.SUSPENSAO, '2026-01-01'), evento('l', Tipo.LICENCA, '2026-01-02'), evento('r', Tipo.RESTAURACAO, '2026-02-01', 1, 's')];
    expect(avaliarExercicio(periodo, atos, d('2026-02-01')).motivo).toBe('LICENCA');
    expect(avaliarExercicio(periodo, [ordenacao, evento('x', Tipo.RESTAURACAO, '2026-02-01', 1, 's')], d('2026-02-01')).motivo).toBe('HISTORICO_INCONSISTENTE');
  });
  it('restauração não reabre mandato encerrado nem ordenação desfaz suspensão', () => {
    const atos = [ordenacao, evento('s', Tipo.SUSPENSAO, '2026-01-01'), evento('o', Tipo.ORDENACAO, '2026-01-02'), evento('r', Tipo.RESTAURACAO, '2026-02-01', 1, 's')];
    expect(avaliarExercicio(periodo, atos, d('2026-01-02')).motivo).toBe('SUSPENSAO');
    expect(avaliarExercicio({ ...periodo, termino_efetivo: d('2026-01-31') }, atos, d('2026-02-01')).motivo).toBe('MANDATO_ENCERRADO');
  });
});
