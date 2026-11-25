import { regiaoHtml } from './pagina-html';
import type { Ocorrencia } from './composicao-pagina';
import { composicaoPaginaSchema as schema, leituraComposicaoSchema, valoresPaginaSchema } from './composicao-pagina';

const id = '310797a0-cf1d-4d3a-b679-1a0c2890fb2a';
const espacamento = { superior: 0, inferior: 0 };
const pagina = {
  papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
  margens_cm: { esquerda: 2, direita: 2, superior: 2, inferior: 2 },
  espacamento_cm: { corpo: espacamento, rodape: espacamento, cabecalho: espacamento },
};
const paragrafo = { tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [
  { tipo: 'texto', texto: 'Convocação', negrito: true }, { tipo: 'referencia_nota', nota_id: id },
] };
const exemplo = { versao_formato: 1, pagina, corpo: [paragrafo], cabecalho: [], rodape: [], notas: { [id]: { texto: 'Edital.' } } };

describe('composição JSON da página', () => {
  it('preserva formatação, âncora e texto da nota ao reabrir', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(exemplo)))).toEqual(exemplo);
  });
  it.each([
    { notas: {} }, { corpo: [] }, { corpo: [paragrafo, paragrafo] },
    { corpo: [], rodape: [paragrafo] }, { versao_formato: 2 },
    { pagina: { ...pagina, margens_cm: { ...pagina.margens_cm, esquerda: 19 } } },
  ])('recusa composições inconsistentes', alteracao => {
    expect(schema.safeParse({ ...exemplo, ...alteracao }).success).toBe(false);
  });
});

describe('valores copiados para o documento', () => {
  const origem = { tipo: 'documento_anterior', versao_id: id, campo_id: id };
  it.each([
    ['sim_nao', false, false], ['numero', false, 0], ['data', false, null],
    ['texto', true, ['Primeiro', 'Segundo']], ['texto', true, []],
  ])('preserva valor e origem (%s)', (tipo, multiplo, valor) => {
    const dados = { [id]: { tipo, multiplo, valor, origem, ajustado_manualmente: false } };
    expect(valoresPaginaSchema.parse(dados)).toEqual(dados);
  });
  it('rejeita uma lista de datas inválidas', () => {
    expect(valoresPaginaSchema.safeParse({
      [id]: { tipo: 'data', multiplo: true, valor: ['2026-02-30'], origem, ajustado_manualmente: false },
    }).success).toBe(false);
  });
});

describe('apresentação das ocorrências da biblioteca', () => {
  const resolver = (_chave: string, original: string) => original;
  const escapar = (s: string) => s.replaceAll('<', '&lt;');
  function renderizar(apresentacao: Ocorrencia['apresentacao'], itens: string[], indice?: number) {
    const campo: Ocorrencia = { tipo: 'campo', campo_id: id, apresentacao, indice };
    const valores = valoresPaginaSchema.parse({ [id]: { tipo: 'texto', multiplo: true, origem: { tipo: 'manual' }, ajustado_manualmente: true, valor: itens } });
    return regiaoHtml([{ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [campo] }], resolver, escapar, valores);
  }
  it.each([['individual'],['em_linha'],['lista_marcadores'],['lista_numerada']] as const)('suprime a linha vazia em %s', modo => {
    expect(renderizar(modo, [])).toBe('');
  });
  it('separa grupos, preserva a ordem e seleciona um item individual', () => {
    const itens = ['Ana','Bruno','Carla'];
    expect(renderizar('em_linha', itens.slice(0,1))).toContain('>Ana<');
    expect(renderizar('em_linha', itens.slice(0,2))).toContain('Ana e Bruno');
    expect(renderizar('em_linha', itens)).toContain('Ana, Bruno e Carla');
    expect(renderizar('individual', itens, 1)).toContain('>Bruno<');
    expect(renderizar('lista_marcadores', ['<texto>'])).toContain('<ul><li><span style="">&lt;texto>');
    expect(renderizar('lista_numerada', itens).match(/<li>/g)).toHaveLength(3);
  });
});

describe('contrato de leitura do editor dedicado', () => {
  const imagem = {
    tipo: 'imagem', arquivo_id: id, ocorrencia_id: id, descricao: 'Logo', legenda: 'Secretaria',
    largura_cm: 4, altura_cm: 4, ajuste: 'ajustar', manter_proporcao: true, horizontal: 'esquerda',
    vertical: 'centro', x_cm: 0, y_cm: 0, relacao: 'a_frente', opacidade: 1, distancia_texto_cm: 0,
  };
  const comImagem = (dados: object = {}) => ({ ...paragrafo, trechos: [{ ...imagem, ...dados }] });
  const v2 = { ...exemplo, versao_formato: 2, pagina: { ...pagina, altura_minima_cm: { cabecalho: 2, rodape: 1 } },
    cabecalho: [comImagem({ repeticao: 'primeira' })] };

  it('distingue leitura e gravação vigente e conserva as ocorrências ao reabrir', () => {
    expect(leituraComposicaoSchema.parse(exemplo)).toEqual(exemplo);
    expect(leituraComposicaoSchema.parse(JSON.parse(JSON.stringify(v2)))).toEqual(v2);
    expect(schema.safeParse(v2).success).toBe(false);
    expect(leituraComposicaoSchema.safeParse({ ...v2, versao_formato: 3 }).success).toBe(false);
  });

  it.each([
    { cabecalho: [comImagem({ largura_cm: -1 })] },
    { rodape: [comImagem()] },
    { corpo: [{ tipo: 'lista', ordenada: true, itens: [[comImagem({ repeticao: 'primeira' }), paragrafo]] }], cabecalho: [] },
    { cabecalho: [comImagem({ opacidade: 1.5 })] },
    { pagina: { ...v2.pagina, altura_minima_cm: { cabecalho: 20, rodape: 7 } } },
  ])('rejeita medida, repetição, identidade ou geometria inválida', alteracao => {
    expect(leituraComposicaoSchema.safeParse({ ...v2, ...alteracao }).success).toBe(false);
  });
  it('aceita dois usos do mesmo arquivo com identidades próprias', () => {
    const outra = comImagem({ ocorrencia_id: '9327fbe6-9a2b-44f1-b2eb-7da57ab5f07c' });
    expect(leituraComposicaoSchema.safeParse({ ...v2, rodape: [outra] }).success).toBe(true);
  });
});
