import { Prisma } from '@prisma/client';
import { compararRolNoInicio, criarComparadorRol, impactoOrgaos } from './impacto-orgaos';

const evento = (dia: string, rol: string, ordem: number | null = null) => ({ data_evento: new Date(`${dia}T00:00:00Z`), rol, ordem_dia: ordem });
const inicio = new Date('2025-01-01T00:00:00Z');

describe('comparação do rol no início de vínculos', () => {
  it('distingue rol preservado e alterado sem afirmar elegibilidade', () => {
    const antes = [evento('2020-01-01', 'COMUNGANTES')];
    expect(compararRolNoInicio(antes, [evento('2020-01-02', 'COMUNGANTES')], inicio)).toBe('PRESERVADO');
    expect(compararRolNoInicio(antes, [evento('2020-01-01', 'NAO_COMUNGANTES')], inicio)).toBe('ALTERADO');
  });
  it('não presume ordem entre ato de órgão e evento da mesma data', () => {
    const mesmoDia = [evento('2025-01-01', 'COMUNGANTES', 1)];
    expect(compararRolNoInicio(mesmoDia, mesmoDia, inicio)).toBe('INDETERMINADO');
  });
  it('sinaliza histórico ausente ou com ordem ambígua', () => {
    const ambiguo = [evento('2024-01-01', 'COMUNGANTES'), evento('2024-01-01', 'EXCLUIDOS')];
    expect(compararRolNoInicio([], [evento('2020-01-01', 'COMUNGANTES')], inicio)).toBe('INDETERMINADO');
    expect(compararRolNoInicio(ambiguo, ambiguo, inicio)).toBe('INDETERMINADO');
  });
  it('preserva a comparação original para históricos com empates, ordens incompletas e datas iguais', () => {
    let estado = 219;
    const aleatorio = (limite: number) => { estado = (estado * 48271) % 2147483647; return estado % limite; };
    const data = (n: number) => new Date(Date.UTC(2020, 0, n + 1));
    for (let caso = 0; caso < 60; caso++) {
      const gerar = () => Array.from({ length: aleatorio(30) }, () => ({ data_evento: data(aleatorio(40)), ordem_dia: [null, 1, 2, 3][aleatorio(4)], rol: ['COMUNGANTES', 'NAO_COMUNGANTES', 'EXCLUIDOS'][aleatorio(3)] }));
      const antes = gerar(), depois = gerar(), comparar = criarComparadorRol(antes, depois);
      for (let dia = 0; dia < 45; dia++) expect(comparar(data(dia))).toBe(compararRolNoInicio(antes, depois, data(dia)));
    }
  });
  it('compara uma lista extensa de vínculos mantendo a assinatura e os totais', async () => {
    const anterior = process.env.FEATURE_ORGAOS;
    process.env.FEATURE_ORGAOS = 'true';
    try {
      const eventos = Array.from({ length: 2000 }, (_, i) => ({ data_evento: new Date(Date.UTC(2000, 0, i + 1)), ordem_dia: null, rol: i % 2 ? 'COMUNGANTES' : 'NAO_COMUNGANTES' }));
      const vinculos = Array.from({ length: 3000 }, (_, i) => ({ id: String(i), inicio: new Date(Date.UTC(2001, 0, i + 1)), orgao: { nome: 'Unidade' } }));
      const tx = { membro_orgao: { findMany: jest.fn().mockResolvedValue(vinculos) }, ocupacao_cargo: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as Prisma.TransactionClient;
      let todos: { comparacao_rol: string }[] = [];
      const resultado = await impactoOrgaos(tx, 'igreja', 'pessoa', new Date('2000-01-01T00:00:00Z'), true, { antes: eventos, depois: eventos }, v => { todos = v; });
      expect(resultado).toMatchObject({ participacoes: 3000, detalhes_limitados: true });
      expect(todos).toHaveLength(3000);
      expect(resultado!.rol_alterado! + resultado!.rol_preservado! + resultado!.rol_indeterminado!).toBe(3000);
      for (const i of [0, 500, 2000, 2999]) expect(todos[i].comparacao_rol).toBe(compararRolNoInicio(eventos, eventos, vinculos[i].inicio));
    } finally { if (anterior === undefined) delete process.env.FEATURE_ORGAOS; else process.env.FEATURE_ORGAOS = anterior; }
  });
  it('contabiliza todos os vínculos, mesmo quando os detalhes são limitados', async () => {
    const anterior = process.env.FEATURE_ORGAOS;
    process.env.FEATURE_ORGAOS = 'true';
    try {
      const vinculos = Array.from({ length: 101 }, (_, i) => ({ id: String(i), inicio, orgao: { nome: 'Unidade' } }));
      const tx = { membro_orgao: { findMany: jest.fn().mockResolvedValue(vinculos) }, ocupacao_cargo: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as Prisma.TransactionClient;
      const eventos = [evento('2020-01-01', 'COMUNGANTES')];
      const resultado = await impactoOrgaos(tx, 'igreja', 'pessoa', new Date('2020-01-01T00:00:00Z'), true, { antes: eventos, depois: eventos });
      expect(resultado).toMatchObject({ participacoes: 101, rol_preservado: 101, detalhes_limitados: true });
      expect(resultado?.detalhes).toHaveLength(100);
    } finally { if (anterior === undefined) delete process.env.FEATURE_ORGAOS; else process.env.FEATURE_ORGAOS = anterior; }
  });
});
