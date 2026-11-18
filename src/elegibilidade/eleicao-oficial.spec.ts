import { avaliarEleicaoOficial } from './eleicao-oficial';
const politica = { idadeMinima: 18, fonte: 'Norma local', versao: '1', vigenteDesde: '2024-01-01', aniversarioBissexto: '28_FEVEREIRO' as const };
const base = { dataEleicao: '2026-03-01', dataRecepcao: '2025-03-01', evidenciaRecepcao: 'Registro de recepção', dataNascimento: '2008-03-01', capacidadeConfirmada: true, evidenciaCapacidade: 'Declaração' };
describe('elegibilidade à eleição de oficial', () => {
  it('aceita o dia em que prazo e idade completam', () => expect(avaliarEleicaoOficial(base, politica).requisitosAtendidos).toBe(true));
  it('rejeita dia anterior e não confunde aniversário com idade atual', () => expect(avaliarEleicaoOficial({ ...base, dataEleicao: '2026-02-28' }, politica).requisitosAtendidos).toBe(false));
  it('exceção de transferência não dispensa idade ou capacidade', () => {
    const b = { ...base, dataRecepcao: '2026-01-01', capacidadeConfirmada: false, excecaoTransferencia: { oficialTransferido: true, autoridade: 'Conselho', evidencia: 'Ata externa' } };
    const r = avaliarEleicaoOficial(b, politica);
    expect(r.excecaoAplicada).toBe(true); expect(r.requisitosAtendidos).toBe(false);
    expect(avaliarEleicaoOficial({ ...b, capacidadeConfirmada: true }, politica).requisitosAtendidos).toBe(true);
    expect(avaliarEleicaoOficial({ ...b, capacidadeConfirmada: true, excecaoTransferencia: { ...b.excecaoTransferencia, evidencia: '' } }, politica).requisitosAtendidos).toBe(false);
  });
  it('define explicitamente o marco de ano bissexto e rejeita data inválida', () => {
    expect(avaliarEleicaoOficial({ ...base, dataRecepcao: '2024-02-29', dataEleicao: '2025-02-28', dataNascimento: '1990-01-01' }, politica).requisitosAtendidos).toBe(true);
    expect(avaliarEleicaoOficial({ ...base, dataRecepcao: '2024-02-29', dataEleicao: '2025-02-28', dataNascimento: '1990-01-01' }, { ...politica, aniversarioBissexto: '01_MARCO' }).requisitosAtendidos).toBe(false);
    expect(() => avaliarEleicaoOficial({ ...base, dataRecepcao: '2025-02-30' }, politica)).toThrow();
  });
});
