// Executar a partir da API: npm run prova:pagina
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { composicaoPaginaSchema, valoresPaginaSchema, type ComposicaoPagina } from '../../src/secretaria/composicao-pagina';

const campoPauta = '2ab29778-664a-4d94-a574-459a2e6a35f7';
const nota = '44b9ce76-7e7f-4f28-941b-2074dae8d2b7';
const textoNota = 'Convocação publicada no edital da assembleia.';
const espacamento = { superior: 0, inferior: 0 };
const paragrafo = (texto: string) => ({
  tipo: 'paragrafo' as const, alinhamento: 'esquerda' as const,
  trechos: [{ tipo: 'texto' as const, texto }],
});
function exemplo(ata: boolean, teorNota = textoNota): ComposicaoPagina {
  return composicaoPaginaSchema.parse({
    versao_formato: 1, pagina: {
      papel: 'A4', orientacao: 'retrato', tamanho_pt: 12, fonte: 'Noto Serif',
      margens_cm: { superior: 2, direita: 2, inferior: 2, esquerda: 2 },
      espacamento_cm: { cabecalho: { superior: 0, inferior: 0.4 }, corpo: espacamento, rodape: { superior: 0.3, inferior: 0 } },
    },
    cabecalho: [paragrafo('Secretaria da Assembleia Geral')],
    corpo: ata ? [
      paragrafo('Ata de assembleia ordinária'),
      { tipo: 'campo', campo_id: campoPauta, apresentacao: 'lista_numerada' },
      { ...paragrafo('Deliberação sobre o relatório anual'), trechos: [
        ...paragrafo('Deliberação sobre o relatório anual').trechos,
        { tipo: 'referencia_nota', nota_id: nota },
      ] },
    ] : [paragrafo('Ofício de convocação'), paragrafo('Convidamos os membros a participar da assembleia ordinária.')],
    rodape: [paragrafo('Secretaria · Documento de demonstração')],
    notas: ata ? { [nota]: { texto: teorNota } } : {},
  });
}

// Medição no DOM real. A prova trata parágrafos curtos e itens de pauta como unidades.
// O editor definitivo deverá fragmentar também parágrafos, tabelas e imagens extensos.
function paginar({ entrada, valores }: { entrada: ComposicaoPagina; valores: Record<string, string[]> }) {
  const pagina = entrada.pagina;
  document.body.replaceChildren();
  function elemento<K extends keyof HTMLElementTagNameMap>(tipo: K, pai: HTMLElement, texto = '') {
    const el = document.createElement(tipo);
    el.textContent = texto;
    pai.append(el);
    return el;
  }
  function regiaoFixa(secao: 'cabecalho' | 'rodape', pai: HTMLElement) {
    for (const b of entrada[secao]) {
      if (b.tipo !== 'paragrafo') throw Error('Região fixa fora do escopo da prova');
      for (const t of b.trechos) if (t.tipo === 'texto') elemento('span', pai, t.texto);
    }
  }
  function novaPagina() {
    const folha = elemento('article', document.body);
    const m = pagina.margens_cm;
    folha.style.padding = [m.superior, m.direita, m.inferior, m.esquerda].map(v => v + 'cm').join(' ');
    const cabecalho = elemento('header', folha);
    const corpo = elemento('main', folha);
    const notas = elemento('aside', folha);
    const rodape = elemento('footer', folha);
    for (const [nome, el] of Object.entries({ cabecalho, corpo, rodape })) {
      const e = pagina.espacamento_cm[nome as keyof typeof pagina.espacamento_cm];
      el.style.paddingBlock = e.superior + 'cm ' + e.inferior + 'cm';
    }
    regiaoFixa('cabecalho', cabecalho);
    regiaoFixa('rodape', rodape);
    return { folha, corpo, notas, rodape };
  }
  let atual = novaPagina();
  const cabe = () => {
    const limite = atual.folha.getBoundingClientRect().bottom - parseFloat(getComputedStyle(atual.folha).paddingBottom);
    return atual.rodape.getBoundingClientRect().bottom <= limite + 0.1;
  };
  const numeracao = new Map<string, number>();
  function inserir(linha: HTMLElement, ids: string[]) {
    const haviaCorpo = atual.corpo.childElementCount > 0 || atual.notas.childElementCount > 0;
    atual.corpo.append(linha);
    const notas = ids.map(id => elemento('p', atual.notas, numeracao.get(id) + '. ' + entrada.notas[id].texto));
    if (cabe()) return;
    if (haviaCorpo) {
      const anterior = atual;
      atual = novaPagina();
      atual.corpo.append(linha);
      atual.notas.append(...notas);
      if (cabe()) return;
      // Uma nota maior que uma página pode começar junto da referência na folha original.
      const vazia = atual;
      atual = anterior;
      atual.corpo.append(linha);
      atual.notas.append(...notas);
      vazia.folha.remove();
    }
    if (ids.length !== 1) throw Error('Bloco fora dos limites da prova');
    const palavras = entrada.notas[ids[0]].texto.split(/\s+/);
    let inicio = 0;
    let trecho = notas[0];
    while (inicio < palavras.length) {
      const prefixo = numeracao.get(ids[0]) + (inicio ? '. (continuação) ' : '. ');
      let minimo = inicio, maximo = palavras.length;
      while (minimo < maximo) {
        const fim = Math.ceil((minimo + maximo) / 2);
        trecho.textContent = prefixo + palavras.slice(inicio, fim).join(' ');
        if (cabe()) minimo = fim;
        else maximo = fim - 1;
      }
      if (minimo === inicio) {
        if (inicio === 0 && haviaCorpo) {
          atual = novaPagina();
          atual.corpo.append(linha);
          atual.notas.append(trecho);
          trecho.textContent = prefixo + palavras[inicio];
          if (cabe()) continue;
        }
        throw Error('Não cabe o início da nota na página da referência');
      }
      trecho.textContent = prefixo + palavras.slice(inicio, minimo).join(' ');
      inicio = minimo;
      if (inicio < palavras.length) {
        atual = novaPagina();
        trecho = elemento('p', atual.notas);
      }
    }
  }
  for (const b of entrada.corpo) {
    if (b.tipo === 'campo' && b.apresentacao === 'lista_numerada') {
      valores[b.campo_id].forEach((item, i) => {
        const linha = document.createElement('p');
        linha.textContent = (i + 1) + '. ' + item;
        inserir(linha, []);
      });
    } else if (b.tipo === 'paragrafo') {
      const linha = document.createElement('p');
      const ids: string[] = [];
      for (const t of b.trechos) {
        if (t.tipo === 'texto') linha.append(document.createTextNode(t.texto));
        else if (t.tipo === 'referencia_nota') {
          ids.push(t.nota_id);
          numeracao.set(t.nota_id, numeracao.size + 1);
          elemento('sup', linha, String(numeracao.size));
        }
      }
      inserir(linha, ids);
    } else throw Error('Bloco fora do escopo da prova');
  }
  return Array.from(document.querySelectorAll('article')).map(folha => ({
    corpo: folha.querySelector('main')!.innerText, notas: folha.querySelector('aside')!.innerText,
  }));
}

async function main() {
  const pasta = resolve('../output/pdf/secretaria-editor');
  await mkdir(pasta, { recursive: true });
  const fonte = await readFile(require.resolve('@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><style>
      @font-face { font-family:Noto; src:url(data:font/woff2;base64,${fonte.toString('base64')}) }
      @page { size:A4; margin:0 } * { box-sizing:border-box } body { margin:0; font:12pt/1.45 Noto,serif }
      article { width:210mm; height:297mm; display:flex; flex-direction:column; break-after:page }
      article:last-child { break-after:auto } article > * { flex:none }
      header { border-bottom:1px solid #bbb; font-size:11pt } main p { margin:0; padding:2mm 0 }
      aside { margin-top:auto; font-size:10pt } aside p { margin:0; padding:2mm 0; border-top:1px solid #bbb }
      footer { border-top:1px solid #bbb; color:#444; font-size:9pt }
    </style><body></body></html>`);
    await page.evaluate(async () => { await document.fonts.load('12pt Noto'); await document.fonts.ready; });
    const assuntos = ['Leitura da ata anterior', 'Parecer do conselho', 'Relatório das atividades'];
    for (const [nome, itens, longa] of [
      ['oficio', 0, false], ['ata-inicial', 3, false], ['ata-ampliada', 34, false], ['ata-nota-longa', 3, true],
    ] as const) {
      const entrada = exemplo(itens > 0, longa ? (textoNota + ' ').repeat(190).trim() + ' Fim da nota.' : textoNota);
      const preenchimento = valoresPaginaSchema.parse({
        [campoPauta]: {
          tipo: 'texto', multiplo: true, origem: { tipo: 'manual' }, ajustado_manualmente: false,
          valor: Array.from({ length: itens }, (_, i) => assuntos[i % assuntos.length]),
        },
      })[campoPauta];
      assert.ok(preenchimento.tipo === 'texto' && preenchimento.multiplo);
      const valores = { [campoPauta]: preenchimento.valor };
      const paginas = await page.evaluate(paginar, { entrada, valores });
      const esperado = nome === 'ata-ampliada' ? 2 : 1;
      const indice = paginas.findIndex(p => p.corpo.includes('Deliberação'));
      if (itens) {
        assert.equal(indice + 1, esperado);
        assert.ok(paginas[indice].notas.includes(textoNota));
      }
      const arquivo = join(pasta, nome + '.pdf');
      const pdf = await page.pdf({ path: arquivo, preferCSSPageSize: true, printBackground: true });
      assert.equal((await PDFDocument.load(pdf)).getPageCount(), paginas.length);
      if (longa) assert.ok(paginas.length > 1);
      else assert.equal(paginas.length, esperado);
      const textos = execFileSync('pdftotext', ['-layout', arquivo, '-'], { encoding: 'utf8' }).trimEnd().split('\f');
      assert.equal(textos.length, paginas.length);
      for (const [i, texto] of textos.entries()) {
        assert.ok(texto.includes('Secretaria da Assembleia Geral') && texto.includes('Documento de demonstração'));
        assert.equal(texto.includes('Deliberação sobre o relatório anual'), i === indice);
        assert.equal(texto.includes('Convocação publicada'), paginas[i].notas.includes('Convocação publicada'));
        if (longa && i > indice) assert.ok(texto.includes('(continuação)'));
      }
      if (longa) assert.ok(textos.at(-1)!.includes('Fim da nota.'));
      console.log(nome, paginas.length, 'página(s)', arquivo);
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
