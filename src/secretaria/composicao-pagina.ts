import { z } from 'zod';

// O discriminador identifica o formato da página, independentemente da revisão do ato.
const fonte = z.enum(['Noto Serif', 'Noto Sans', 'Liberation Serif']);
const tamanho = z.number().positive().max(144);
const cm = z.number().nonnegative().max(29.7);
const espacamento = z.strictObject({ superior: cm, inferior: cm });
const alinhamento = z.enum(['esquerda', 'direita', 'centro', 'justificado']);
const estilo = {
  fonte: fonte.optional(), tamanho_pt: tamanho.optional(),
  negrito: z.boolean().optional(), italico: z.boolean().optional(), sublinhado: z.boolean().optional(),
};
const campoId = z.uuid();
const notaId = z.uuid();
const campo = z.strictObject({
  tipo: z.literal('campo'), campo_id: campoId,
  apresentacao: z.enum(['individual', 'em_linha', 'lista_marcadores', 'lista_numerada']), indice: z.number().int().min(0).max(999).optional(), ...estilo,
});
const referencia = z.strictObject({ tipo: z.literal('referencia_nota'), nota_id: notaId });
const trecho = z.discriminatedUnion('tipo', [
  z.strictObject({ tipo: z.literal('texto'), texto: z.string().max(20000), ...estilo }),
  campo, referencia,
]);
const paragrafo = z.strictObject({
  tipo: z.literal('paragrafo'), alinhamento,
  estilo: z.enum(['normal', 'titulo', 'subtitulo']).optional(),
  trechos: z.array(trecho).max(1000),
});
function blocosComParagrafos<P extends typeof paragrafo | typeof paragrafoComImagem>(p: P) {
  const paragrafosInternos = z.array(p).min(1).max(100);
  return [
    p,
    z.strictObject({ tipo: z.literal('lista'), ordenada: z.boolean(), itens: z.array(paragrafosInternos).max(100) }),
    z.strictObject({ tipo: z.literal('tabela'), linhas: z.array(z.array(paragrafosInternos).min(1).max(12)).min(1).max(100), primeira_linha_cabecalho: z.boolean() }),
    z.strictObject({ tipo: z.literal('imagem'), arquivo_id: z.uuid(), descricao: z.string().max(255) }),
    z.strictObject({ tipo: z.literal('quebra') }),
    z.strictObject({ tipo: z.literal('assinaturas') }),
  ] as const;
}

const bloco = z.discriminatedUnion('tipo', [
  ...blocosComParagrafos(paragrafo),
  z.strictObject({ tipo: z.literal('campo'), campo_id: campoId, apresentacao: z.enum(['lista_marcadores', 'lista_numerada']) }),
]);

const composicaoBase = z.strictObject({
  versao_formato: z.literal(1),
  pagina: z.strictObject({
    papel: z.literal('A4'), orientacao: z.literal('retrato'), fonte, tamanho_pt: tamanho,
    margens_cm: z.strictObject({ superior: cm, inferior: cm, esquerda: cm, direita: cm }),
    espacamento_cm: z.strictObject({ cabecalho: espacamento, corpo: espacamento, rodape: espacamento }),
  }),
  cabecalho: z.array(bloco).max(30), corpo: z.array(bloco).max(200), rodape: z.array(bloco).max(30),
  notas_ativas: z.boolean().optional(),
  notas: z.record(notaId, z.strictObject({ texto: z.string().trim().min(1).max(20000) })),
});

// A ocorrência vive no trecho de texto que a ancora. Reordenar o parágrafo leva a imagem junto.
export const imagemPaginaV2Schema = z.strictObject({
  tipo: z.literal('imagem'), ocorrencia_id: z.uuid(), arquivo_id: z.uuid(),
  descricao: z.string().max(255), legenda: z.string().max(255).optional(),
  largura_cm: cm.positive(), altura_cm: cm.positive(), manter_proporcao: z.boolean(),
  ajuste: z.enum(['original', 'ajustar', 'preencher', 'personalizado']),
  horizontal: z.enum(['esquerda', 'centro', 'direita']), vertical: z.enum(['topo', 'centro', 'base']),
  x_cm: z.number().min(-21).max(21), y_cm: z.number().min(-29.7).max(29.7),
  relacao: z.enum(['em_linha', 'acima_abaixo', 'ao_redor', 'atraves', 'atras', 'a_frente']),
  opacidade: z.number().min(0).max(1), distancia_texto_cm: cm,
  repeticao: z.enum(['todas', 'primeira']).optional(),
});
const paragrafoComImagem = paragrafo.extend({
  trechos: z.array(z.discriminatedUnion('tipo', [...trecho.options, imagemPaginaV2Schema])).max(1000),
});
const blocoV2 = z.discriminatedUnion('tipo', blocosComParagrafos(paragrafoComImagem));
const composicaoV2Base = composicaoBase.extend({
  versao_formato: z.literal(2),
  pagina: composicaoBase.shape.pagina.extend({ altura_minima_cm: z.strictObject({ cabecalho: cm, rodape: cm }) }),
  cabecalho: z.array(blocoV2).max(30), corpo: z.array(blocoV2).max(200), rodape: z.array(blocoV2).max(30),
});

function validarComposicao(valor: z.infer<typeof composicaoBase> | z.infer<typeof composicaoV2Base>, ctx: z.RefinementCtx) {
  const erro = (message: string) => ctx.addIssue({ code: 'custom', message });
  const { margens_cm: m, espacamento_cm } = valor.pagina;
  const interno = Object.values(espacamento_cm).reduce((total, e) => total + e.superior + e.inferior, 0);
  const minimos = valor.versao_formato === 2 ? valor.pagina.altura_minima_cm : { cabecalho: 0, rodape: 0 };
  if (m.esquerda + m.direita >= 21 || m.superior + m.inferior + interno + minimos.cabecalho + minimos.rodape >= 29.7) erro('A configuração deve deixar espaço útil na página A4.');
  if (JSON.stringify(valor).length > 200000) erro('Composição excede 200000 caracteres.');

  const usadas = new Set<string>();
  const imagens = new Set<string>();
  for (const regiao of ['cabecalho', 'corpo', 'rodape'] as const) {
    for (const b of valor[regiao]) {
      const paragrafos = b.tipo === 'paragrafo' ? [b] : b.tipo === 'lista' ? b.itens.flat() : b.tipo === 'tabela' ? b.linhas.flat(2) : [];
      for (const p of paragrafos) for (const t of p.trechos) {
        if (t.tipo === 'imagem') {
          if (imagens.has(t.ocorrencia_id)) erro('Cada ocorrência de imagem deve ter identidade própria.');
          imagens.add(t.ocorrencia_id);
          if (regiao === 'corpo' && t.repeticao) erro('Repetição de imagem exclusiva de cabeçalho e rodapé.');
        }
        if (t.tipo !== 'referencia_nota') continue;
        if (regiao !== 'corpo' || usadas.has(t.nota_id) || !valor.notas[t.nota_id]) erro('Cada nota deve ter uma única referência no corpo.');
        usadas.add(t.nota_id);
      }
    }
  }
  if (Object.keys(valor.notas).some(id => !usadas.has(id))) erro('Nota sem referência no corpo.');
}

// O leitor aceita as duas gerações. O discriminador mantém o contrato v1 estrito.
export const composicaoPaginaSchema = composicaoBase.superRefine(validarComposicao);
export const composicaoPaginaV2Schema = composicaoV2Base.superRefine(validarComposicao);
export const leituraComposicaoSchema = z.discriminatedUnion('versao_formato', [composicaoPaginaSchema, composicaoPaginaV2Schema]);
export type ComposicaoPaginaV2 = z.infer<typeof composicaoPaginaV2Schema>;
export type ImagemPaginaV2 = z.infer<typeof imagemPaginaV2Schema>;

export type ComposicaoPagina = z.infer<typeof leituraComposicaoSchema>;

const origem = z.discriminatedUnion('tipo', [
  z.strictObject({ tipo: z.literal('manual') }),
  z.strictObject({ tipo: z.literal('sistema'), chave: z.string().min(1).max(80), cadastro: z.string().max(32).optional(), registro_id: z.uuid().optional(), atualizado_em: z.iso.datetime().optional(), revisao: z.number().int().positive().optional() }),
  z.strictObject({ tipo: z.literal('documento_anterior'), versao_id: z.uuid(), campo_id: campoId }),
]);
function valorTipado<T extends string, S extends z.ZodType>(tipo: T, item: S) {
  const dados = { tipo: z.literal(tipo), origem, ajustado_manualmente: z.boolean() };
  return z.discriminatedUnion('multiplo', [
    z.strictObject({ ...dados, multiplo: z.literal(true), valor: z.array(item).max(1000) }),
    z.strictObject({ ...dados, multiplo: z.literal(false), valor: item.nullable() }),
  ]);
}

// Ausência de valor é null ou lista vazia. Zero e false são respostas preenchidas.
export const valoresPaginaSchema = z.record(campoId, z.union([
  z.strictObject({ tipo: z.literal('texto'), multiplo: z.literal(true),
    origem: origem.options[1].extend({ chave: z.literal('deliberacoes_reuniao') }),
    ajustado_manualmente: z.literal(false), valor: z.array(z.string().max(200000)).max(100) }),
  valorTipado('texto', z.string().max(20000)),
  valorTipado('numero', z.number()),
  valorTipado('data', z.iso.date()),
  valorTipado('sim_nao', z.boolean()),
])).refine(v => Object.keys(v).length <= 100 && JSON.stringify(v).length <= 800000 &&
  JSON.stringify(Object.fromEntries(Object.entries(v).filter(([,c]) => c.origem.tipo !== 'sistema' || c.origem.chave !== 'deliberacoes_reuniao'))).length <= 200000,
  'Os valores dos campos excedem o limite permitido.');

export const paginaTextoSchema = leituraComposicaoSchema.refine(
  p => [p.cabecalho, p.corpo, p.rodape].every(regiao => regiao.every(b => b.tipo !== 'campo')),
  'Insira campos dentro de um parágrafo.',
);

export function paragrafos(blocos: ComposicaoPagina['corpo'][number][]) {
  return blocos.flatMap<z.infer<typeof paragrafoComImagem>>(b => b.tipo === 'paragrafo' ? [b] : b.tipo === 'lista' ? b.itens.flat() : b.tipo === 'tabela' ? b.linhas.flat(2) : []);
}

export function textosPagina(p?: ComposicaoPagina) {
  return p ? paragrafos([...p.cabecalho, ...p.corpo, ...p.rodape]).map(b =>
    b.trechos.map(t => t.tipo === 'texto' ? t.texto : '').join('')) : [];
}

export type ValoresPagina = z.infer<typeof valoresPaginaSchema>;
export type Ocorrencia = z.infer<typeof campo>;
export function ocorrencias(p?: ComposicaoPagina): Ocorrencia[] {
  return p ? paragrafos([...p.cabecalho, ...p.corpo, ...p.rodape]).flatMap(b => b.trechos.filter(t => t.tipo === 'campo')) : [];
}
export function itensCampo(c: Ocorrencia, valores?: ValoresPagina) {
  const v = valores?.[c.campo_id];
  if (!v || v.valor === null) return [];
  const itens = Array.isArray(v.valor) ? v.valor : [v.valor];
  const escolhidos = c.apresentacao === 'individual' ? itens.slice(c.indice ?? 0, (c.indice ?? 0) + 1) : itens;
  return escolhidos.map(x => v.tipo === 'data' ? String(x).split('-').reverse().join('/') :
    typeof x === 'boolean' ? (x ? 'Sim' : 'Não') : typeof x === 'number' ? x.toLocaleString('pt-BR', { maximumFractionDigits: 15 }) : x.trim()).filter(Boolean);
}
export const textoGrupo = (itens: string[]) => itens.length < 2 ? itens.join('') : itens.slice(0, -1).join(', ') + ' e ' + itens.at(-1);
