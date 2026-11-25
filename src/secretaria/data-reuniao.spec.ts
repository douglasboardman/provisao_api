import { numeroPorExtenso } from '../core/numero-por-extenso';
import { dataReuniaoPorExtenso } from './data-reuniao';

describe('Escrita por extenso em português brasileiro', () => {
  it('permite usar cardinais e ordinais fora das datas', () => {
    expect(numeroPorExtenso(1)).toBe('um');
    expect(numeroPorExtenso(1, 'ordinal')).toBe('primeiro');
    expect(numeroPorExtenso(17)).toBe('dezessete');
    expect(numeroPorExtenso(1000n)).toBe('mil');
  });

  it.each([
    ['2000-01-01', 'primeiro', 'janeiro', 'dois mil'],
    ['2024-02-29', 'vinte e nove', 'fevereiro', 'dois mil e vinte e quatro'],
    ['1999-12-31', 'trinta e um', 'dezembro', 'mil novecentos e noventa e nove'],
  ])('usa a data civil da reunião em %s', (data, dia, mes, ano) => {
    expect(dataReuniaoPorExtenso(new Date(data))).toEqual({
      dia_reuniao_por_extenso: dia, mes_reuniao_por_extenso: mes, ano_reuniao_por_extenso: ano,
    });
  });
});
