// Prova geométrica da entrega 1. O paginador de produção continua atendendo a composição v1.
// A unidade indivisível desta prova é o parágrafo com as suas âncoras e notas curtas.
import type { ComposicaoPaginaV2, ImagemPaginaV2 } from '../../src/secretaria/composicao-pagina';

export async function montarFolhas({ comp, arquivos }: { comp: ComposicaoPaginaV2; arquivos: Record<string, string> }) {
  await document.fonts.ready;
  await Promise.all(Object.values(arquivos).map(async src => {
    const img = new Image(); img.src = src; await img.decode();
  }));
  document.body.replaceChildren();
  const cfg = comp.pagina;
  type Bloco = ComposicaoPaginaV2['corpo'][number];
  function imagem(i: ImagemPaginaV2, fixa: boolean) {
    const el = document.createElement('img');
    el.src = arquivos[i.arquivo_id]; el.alt = i.descricao; el.dataset.ocorrencia = i.ocorrencia_id;
    el.style.width = i.largura_cm + 'cm'; el.style.height = i.altura_cm + 'cm';
    el.style.objectFit = { ajustar: 'contain', preencher: 'cover', original: 'none', personalizado: i.manter_proporcao ? 'contain' : 'fill' }[i.ajuste];
    el.style.opacity = String(i.opacidade);
    if (fixa && (i.relacao === 'a_frente' || i.relacao === 'atras')) {
      const x = { esquerda: 0, centro: 50, direita: 100 }[i.horizontal];
      const y = { topo: 0, centro: 50, base: 100 }[i.vertical];
      Object.assign(el.style, { position: 'absolute', left: 'calc(' + x + '% + ' + i.x_cm + 'cm)',
        top: 'calc(' + y + '% + ' + i.y_cm + 'cm)', transform: 'translate(' + -x + '%,' + -y + '%)', zIndex: i.relacao === 'atras' ? '-1' : '1' });
    } else if (!fixa && (i.relacao === 'atraves' || i.relacao === 'ao_redor')) {
      el.style.cssFloat = i.horizontal === 'direita' ? 'right' : 'left';
      if (i.relacao === 'atraves') {
        el.style.shapeOutside = 'url("' + el.src + '")';
        el.style.shapeImageThreshold = '0.5';
      }
      el.style.shapeMargin = i.distancia_texto_cm + 'cm';
    } else throw Error('Disposição fora do cenário de prova.');
    return el;
  }
  type Folha = ReturnType<typeof novaFolha>;
  function bloco(b: Bloco, folha: number, fixa: boolean) {
    if (b.tipo !== 'paragrafo') throw Error('A amostra de paginação exige parágrafos.');
    const p = document.createElement(b.estilo === 'titulo' ? 'h2' : 'p');
    p.style.textAlign = { esquerda: 'left', direita: 'right', centro: 'center', justificado: 'justify' }[b.alinhamento];
    for (const t of b.trechos) {
      if (t.tipo === 'imagem') {
        if (t.repeticao !== 'primeira' || folha === 1) p.append(imagem(t, fixa));
      } else if (t.tipo === 'texto') p.append(t.texto);
      else if (t.tipo === 'referencia_nota') {
        const ref = document.createElement('sup'); ref.dataset.nota = t.nota_id;
        ref.textContent = String(numeros.get(t.nota_id)); p.append(ref);
      } else throw Error('Trecho fora do cenário de prova.');
    }
    return p;
  }
  const numeros = new Map<string, number>();
  for (const b of comp.corpo) if (b.tipo === 'paragrafo') {
    for (const t of b.trechos) if (t.tipo === 'referencia_nota') numeros.set(t.nota_id, numeros.size + 1);
  }
  function novaFolha() {
    const folha = document.createElement('article');
    const n = document.querySelectorAll('article').length + 1;
    const m = cfg.margens_cm;
    folha.style.padding = [m.superior, m.direita, m.inferior, m.esquerda].map(v => v + 'cm').join(' ');
    folha.style.fontFamily = cfg.fonte; folha.style.fontSize = cfg.tamanho_pt + 'pt';
    function regiao(tag: 'header' | 'main' | 'footer', nome: 'cabecalho' | 'corpo' | 'rodape') {
      const el = document.createElement(tag);
      const e = cfg.espacamento_cm[nome];
      el.style.marginBlock = e.superior + 'cm ' + e.inferior + 'cm';
      if (nome !== 'corpo') {
        el.style.minHeight = cfg.altura_minima_cm[nome] + 'cm';
        el.append(...comp[nome].map(b => bloco(b, n, true)));
      }
      return el;
    }
    const main = regiao('main', 'corpo'), footer = regiao('footer', 'rodape');
    const notas = document.createElement('aside');
    folha.append(regiao('header', 'cabecalho'), main, notas, footer);
    document.body.append(folha);
    return { folha, main, notas, footer, n };
  }
  function inserir(b: Bloco, f: Folha) {
    const p = bloco(b, f.n, false);
    const notas = Array.from(p.querySelectorAll<HTMLElement>('[data-nota]'), ref => {
      const n = document.createElement('p'); n.textContent = ref.textContent + '. ' + comp.notas[ref.dataset.nota!].texto;
      return n;
    });
    f.main.append(p); f.notas.append(...notas);
    const limite = f.folha.getBoundingClientRect().bottom - parseFloat(getComputedStyle(f.folha).paddingBottom);
    if (f.footer.getBoundingClientRect().bottom + parseFloat(getComputedStyle(f.footer).marginBottom) <= limite + 0.25) return true;
    p.remove(); notas.forEach(n => n.remove()); return false;
  }
  let atual = novaFolha();
  for (const b of comp.corpo) {
    if (inserir(b, atual)) continue;
    if (!atual.main.childElementCount) throw Error('Parágrafo com suas notas excede a área útil da folha.');
    atual = novaFolha();
    if (!inserir(b, atual)) throw Error('Âncora e nota não cabem na folha seguinte.');
  }
  await Promise.all(Array.from(document.images, img => img.decode()));
}
