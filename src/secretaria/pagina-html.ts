import { itensCampo, textoGrupo, type ValoresPagina, type ComposicaoPagina, type ImagemPaginaV2 } from './composicao-pagina';

const alinhar = { esquerda: 'left', direita: 'right', centro: 'center', justificado: 'justify' };
type Paragrafo = Extract<ComposicaoPagina['corpo'][number], { tipo: 'paragrafo' }>;
type Texto = Extract<Paragrafo['trechos'][number], { tipo: 'texto' }>;
type Estilo = Omit<Texto, 'tipo' | 'texto'>;
type Resolver = (chave: string, original: string) => string;
type Escapar = (texto: string) => string;

function span(t: Estilo, texto: string, escapar: Escapar) {
  const css = [
    t.negrito && 'font-weight:bold', t.italico && 'font-style:italic', t.sublinhado && 'text-decoration:underline',
    t.fonte && 'font-family:' + t.fonte, t.tamanho_pt && 'font-size:' + t.tamanho_pt + 'pt',
  ].filter(Boolean).join(';');
  return '<span style="' + css + '">' + escapar(texto) + '</span>';
}

// Um marcador antigo pode atravessar trechos com formatação diferente.
function textoHtml(trechos: Texto[], resolver: Resolver, escapar: Escapar) {
  const texto = trechos.map(t => t.texto).join('');
  const campos = [...texto.matchAll(/\{\{([A-Z][A-Z0-9_]{0,79})\}\}/g)];
  let inicio = 0, proximo = 0, consumido = 0;
  return trechos.map(t => {
    const fim = inicio + t.texto.length;
    let pos = Math.max(consumido, inicio), parte = '';
    while (proximo < campos.length && campos[proximo].index! < fim) {
      const m = campos[proximo++];
      parte += texto.slice(pos, m.index) + resolver(m[1], m[0]);
      pos = m.index! + m[0].length;
      consumido = pos;
    }
    parte += texto.slice(pos, fim);
    inicio = fim;
    return span(t, parte, escapar);
  }).join('');
}

export function regiaoHtml(blocos: ComposicaoPagina['corpo'], resolver: Resolver, escapar: Escapar, valores?: ValoresPagina, contar?: (n: number) => void, numerosNotas?: Map<string, number>, especial?: (b: Extract<ComposicaoPagina['corpo'][number], {tipo: 'imagem' | 'quebra' | 'assinaturas'}>) => string, imagem?: (i: ImagemPaginaV2) => string, listaNoParagrafo = false) {
  if (!blocos.length) return '<p><br></p>';
  return blocos.map(b => {
    const internos = (p: typeof blocos) => regiaoHtml(p, resolver, escapar, valores, contar, numerosNotas, especial, imagem, listaNoParagrafo);
    if (b.tipo === 'lista') {
      const tag = b.ordenada ? 'ol' : 'ul';
      return '<' + tag + '>' + b.itens.map(item => '<li>' + internos(item) + '</li>').join('') + '</' + tag + '>';
    }
    if (b.tipo === 'tabela') {
      const linhas = b.linhas.map((l, i) => {
        const tag = !i && b.primeira_linha_cabecalho ? 'th' : 'td';
        return '<tr>' + l.map(c => '<' + tag + '>' + internos(c) + '</' + tag + '>').join('') + '</tr>';
      });
      const cabecalho = b.primeira_linha_cabecalho ? '<thead>' + linhas.shift() + '</thead>' : '';
      return '<table>' + cabecalho + '<tbody>' + linhas.join('') + '</tbody></table>';
    }
    if (especial && (b.tipo === 'imagem' || b.tipo === 'assinaturas' || b.tipo === 'quebra')) return especial(b);
    if (b.tipo !== 'paragrafo') throw new Error('Bloco de página incompatível.');
    const tag = b.estilo === 'titulo' ? 'h2' : b.estilo === 'subtitulo' ? 'h3' : 'p';
    const paragrafo = (html: string) => '<' + tag + ' style="text-align:' + alinhar[b.alinhamento] + '">' + html + '</' + tag + '>';
    const partes: string[] = [];
    let linha = '', textos: Texto[] = [];
    function descarregarTexto() {
      linha += textoHtml(textos, resolver, escapar);
      textos = [];
    }
    function descarregarLinha() {
      if (linha) partes.push(paragrafo(linha));
      linha = '';
    }
    for (const t of b.trechos) {
      if (t.tipo === 'texto') { textos.push(t); continue; }
      descarregarTexto();
      if (t.tipo === 'imagem') {
        if (!imagem) throw new Error('Imagem da composição indisponível.');
        linha += imagem(t);
        continue;
      }
      if (t.tipo === 'referencia_nota') {
        const numero = numerosNotas?.get(t.nota_id);
        if (!numero) throw new Error('Referência de nota inválida.');
        linha += '<sup data-nota="' + escapar(t.nota_id) + '">' + numero + '</sup>';
        continue;
      }
      const itens = itensCampo(t, valores);
      if (!itens.length) continue;
      contar?.(itens.reduce((n, x) => n + x.length + 1, 0));
      if (t.apresentacao.startsWith('lista_')) {
        if (listaNoParagrafo || numerosNotas?.size) {
          const lista = itens.map((item, i) => (t.apresentacao === 'lista_numerada' ? (i + 1) + '. ' : '• ') + item).join('\n');
          linha += '<span style="display:block;margin-inline-start:1.3em;white-space:pre-line">' + span(t, lista, escapar) + '</span>';
          continue;
        }
        descarregarLinha();
        const tag = t.apresentacao === 'lista_numerada' ? 'ol' : 'ul';
        partes.push('<' + tag + '>' + itens.map(item => '<li>' + span(t, item, escapar) + '</li>').join('') + '</' + tag + '>');
      } else linha += span(t, textoGrupo(itens), escapar);
    }
    descarregarTexto();
    descarregarLinha();
    return !partes.length && !b.trechos.some(t => t.tipo === 'campo') ? paragrafo('<br>') : partes.join('');
  }).join('');
}
