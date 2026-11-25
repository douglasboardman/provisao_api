// A distribuição CommonJS exporta a função diretamente.
const extenso: typeof import('extenso').default = require('extenso');

export function numeroPorExtenso(valor: number | bigint, forma: 'cardinal' | 'ordinal' = 'cardinal', genero: 'masculino' | 'feminino' = 'masculino'): string {
  return extenso(valor, { locale: 'br', mode: 'number', number: { ordinal: forma === 'ordinal', gender: genero === 'feminino' ? 'female' : 'male' } });
}
