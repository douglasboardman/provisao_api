import { paragrafos } from './composicao-pagina';
import { paginarNotas, estiloParteNota, type FolhaNotas } from './paginar-notas';
import { htmlResolucoes, htmlSignatarios, htmlTermo } from './complementos-leitura';
import { imprimirComposicao } from './imprimir-composicao';
import { regiaoHtml } from './pagina-html';
import type { ComposicaoPagina } from './composicao-pagina';
import { readFile } from 'fs/promises';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { registro_livro_natureza } from '@prisma/client';
import { z } from 'zod';
import { conteudoSchema } from './secretaria.dto';
import type { TipoCampo } from './secretaria.dto';
import type { resolucoesParaMatriz } from './resolucoes';

type Conteudo = z.infer<typeof conteudoSchema>;
export interface FonteRenderizacao {
  tipo: 'ATA' | 'OUTRO'; titulo: string; numero: string; data: string;
  igreja: { nome: string; cidade?: string | null; estado?: string | null; cnpj?: string | null; logradouro?: string | null; numero?: string | null; bairro?: string | null; cep?: string | null; complemento?: string | null };
  conteudo: Conteudo; signatarios: string[]; imagens: Record<string, string>;
  finalidade?: 'RASCUNHO' | 'MATRIZ_APROVADA';
  assinaturaSeparada?: boolean;
  assunto?: string;
  resolucoes?: ReturnType<typeof resolucoesParaMatriz>;
  contexto?: string; perfil?: string; registroLivro?: boolean; logo?: string;
  tiposCampos?: Record<string, TipoCampo>;
  livro?: { numero: number; serie: string; perfil: string; natureza: registro_livro_natureza; paginas?: number; numeroVisivel?: number | null };
}
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const imagemLocal = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const numeroLocal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 });
function campoFormatado(f: FonteRenderizacao, chave: string, original: string) {
  const valor = f.conteudo.campos[chave];
  if (!valor?.trim()) return original;
  switch (f.tiposCampos?.[chave]) {
    case 'DATA': return valor.split('-').reverse().join('/');
    case 'NUMERO': {
      const [inteiro, decimal] = valor.split('.');
      return numeroLocal.format(Number(inteiro)) + (decimal ? ',' + decimal : '');
    }
    case 'SIM_NAO': return valor === 'SIM' ? 'Sim' : 'Não';
    default: return valor;
  }
}
export function htmlDocumento(f: FonteRenderizacao): string {
  let tamanhoTexto = 0;
  const plano = (s: string) => {
    const resolvido = s.replace(/\{\{([A-Z][A-Z0-9_]{0,79})\}\}/g, (original, chave: string) => {
      const valor = campoFormatado(f, chave, original);
      tamanhoTexto += valor.length;
      if (tamanhoTexto > 500000) throw new Error('Limite de expansão dos campos excedido.');
      return valor;
    });
    return escape(resolvido).replace(/\n/g, '<br>');
  };
  const texto = (s: string, rico = false) => {
    if (!rico) return plano(s);
    return s.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g).map((parte, i) => {
      if (i % 2 === 0) return plano(parte);
      if (parte.startsWith('**')) return '<strong>' + plano(parte.slice(2, -2)) + '</strong>';
      return '<em>' + plano(parte.slice(1, -1)) + '</em>';
    }).join('');
  };
  let assinaturasInseridas = false;
  const assinaturas = () => {
    if (assinaturasInseridas) return '';
    assinaturasInseridas = true;
    return htmlSignatarios(f.signatarios);
  };
  const blocos = (lista: NonNullable<Conteudo['estrutura']>['corpo']) => lista.map(b => {
    switch (b.tipo) {
      case 'TEXTO': {
        const tag = b.estilo === 'TITULO' ? 'h2' : b.estilo === 'SUBTITULO' ? 'h3' : 'p';
        return `<${tag} class="${b.alinhamento.toLowerCase()}">${texto(b.texto, b.rico)}</${tag}>`;
      }
      case 'LISTA': { const tag = b.ordenada ? 'ol' : 'ul'; return `<${tag}>${b.itens.map(i => `<li>${texto(i)}</li>`).join('')}</${tag}>`; }
      case 'TABELA': {
        const linhas = [...b.linhas];
        const header = b.primeira_linha_cabecalho ? linhas.shift() : undefined;
        return `<table>${header ? `<thead><tr>${header.map(c => `<th scope="col">${texto(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${linhas.map(l => `<tr>${l.map(c => `<td>${texto(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      case 'IMAGEM': {
        const imagem = f.imagens[b.arquivo_id];
        return imagem && imagemLocal.test(imagem)
          ? `<figure><img src="${imagem}" alt="${escape(b.descricao)}">${b.descricao ? `<figcaption>${escape(b.descricao)}</figcaption>` : ''}</figure>`
          : `<p>[Imagem indisponível: ${escape(b.descricao)}]</p>`;
      }
      case 'QUEBRA': return '<div class="quebra"></div>';
      case 'ASSINATURAS': return assinaturas();
    }
  }).join('');
  const data = new Date(`${f.data}T12:00:00Z`);
  const dataTexto = Number.isNaN(data.getTime()) ? f.data : new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(data);
  const estrutura = f.conteudo.estrutura;
  const temAssinaturas = Object.values(estrutura ?? {}).flat().some(b => b.tipo === 'ASSINATURAS');
  const matriz = f.finalidade === 'MATRIZ_APROVADA';
  const logo = f.logo && imagemLocal.test(f.logo) ? `<img class="logo" src="${f.logo}" alt="">` : '';
  const local = [f.igreja.cidade, f.igreja.estado].filter(Boolean).join('/');
  const apresentacao = !f.livro && f.tipo === 'ATA' && f.perfil ? `<p class="serie">Série ${escape(f.perfil.replaceAll('_', ' '))}${f.registroLivro ? ' · Registro em livro previsto' : ''}</p>` : '';
  const livro = f.livro ? `<p class="serie">Livro nº ${f.livro.numero} · Série ${escape(f.livro.serie)}</p>` : '';
  const dadosTermo = htmlTermo(f.livro?.natureza, f.conteudo.campos);
  const pagina = f.conteudo.composicao;
  if (pagina) {
    const c = pagina.pagina;
    const m = c.margens_cm;
    const resolver = (chave: string, original: string) => {
      const valor = campoFormatado(f, chave, original);
      tamanhoTexto += valor.length;
      if (tamanhoTexto > 500000) throw new Error('Limite de expansão dos campos excedido.');
      return valor;
    };
    const numerosNotas = new Map<string, number>();
    for (const b of paragrafos(pagina.corpo)) {
      for (const t of b.trechos) if (t.tipo === 'referencia_nota') numerosNotas.set(t.nota_id, numerosNotas.size + 1);
    }
    const regiao = (nome: 'cabecalho' | 'corpo' | 'rodape') => regiaoHtml(pagina[nome], resolver, escape, f.conteudo.valores, n => {
      tamanhoTexto += n;
      if (tamanhoTexto > 500000) throw new Error('Limite de expansão dos campos excedido.');
    }, numerosNotas, b => blocos([b.tipo === 'imagem' ? { ...b, tipo: 'IMAGEM' } : { tipo: b.tipo === 'assinaturas' ? 'ASSINATURAS' : 'QUEBRA' }] ), i => {
      return '<span data-ocorrencia="' + escape(i.ocorrencia_id) + '"></span>';
    }, pagina.versao_formato === 2) || (numerosNotas.size && nome !== 'corpo' ? '<p><br></p>' : '');
    const espaco = (nome: 'cabecalho' | 'corpo' | 'rodape') => {
      const e = c.espacamento_cm[nome];
      return e.superior + 'cm 0 ' + e.inferior + 'cm';
    };
    const cabecalho = regiao('cabecalho'), corpo = regiao('corpo'), rodape = regiao('rodape');
    return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><style>
    *{box-sizing:border-box} body{margin:0;width:${21-m.esquerda-m.direita}cm;font:${c.tamanho_pt}pt/1.45 "${c.fonte}";overflow-wrap:anywhere}
    .regiao img{max-width:100%;max-height:15cm}.regiao table{border-collapse:collapse;width:100%}.regiao th,.regiao td{border:1px solid;padding:3px}.regiao .quebra{break-after:page}.regiao h2,.regiao h3{white-space:pre-wrap}
    .regiao p{margin:0;white-space:pre-wrap;orphans:1;widows:1} header{padding:${espaco('cabecalho')}}footer{padding:${espaco('rodape')}}
    .rascunho{position:fixed;top:44%;left:12%;font:bold 48pt sans-serif;color:rgba(100,100,100,.13);transform:rotate(-35deg)}
    .signatario{text-align:center;margin:12mm 0 3mm;break-inside:avoid}.signatario span{display:block;width:64mm;border-top:1px solid;margin:0 auto 2mm}
    </style><body><header class="regiao">${cabecalho}</header>
    <main class="regiao">${corpo}${dadosTermo}${htmlResolucoes(f.resolucoes ?? [])}${assinaturas()}</main>
    <footer class="regiao">${rodape}</footer>${matriz ? '<small>' + escape(f.numero) + ' · Matriz aprovada</small>' : '<div class="rascunho">RASCUNHO</div>'}</body></html>`;
  }
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
  <style>
    @page { size: A4 }
    body { margin: 0; font: 11pt/1.45 Noto, serif; overflow-wrap: anywhere; widows: 3; orphans: 3 }
    body.ata { font-size: 12pt; line-height: 1.55 }
    .institucional, h1, .serie { text-align: center }
    h1 { font-size: 15pt } h2 { font-size: 14pt } h3 { font-size: 12pt }
    h1, h2, h3, caption { break-after: avoid }
    .centro { text-align: center } .direita { text-align: right }
    .justificado, .ata main { text-align: justify } .esquerda { text-align: left }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; margin-block: 4mm }
    th, td { border: 1px solid #555; padding: 4px; overflow-wrap: anywhere; vertical-align: top; text-align: left }
    th { background: #f0f0f0 } thead { display: table-header-group } tr { break-inside: avoid }
    img { max-width: 100%; max-height: 155mm; object-fit: contain }
    img.logo { display: block; max-width: 70mm; max-height: 20mm; margin: 0 auto 2mm }
    figure { margin: 4mm 0; text-align: center; break-inside: avoid }
    figcaption { font-size: 9pt }
    .quebra { break-after: page } .signatario { break-inside: avoid; text-align: center; margin: 10mm auto 0 }
    .signatario span { display: block; width: 64mm; border-top: 1px solid; margin: 0 auto 2mm }
    .rascunho { position: fixed; top: 40%; left: 10%; transform: rotate(-35deg); font: bold 54pt sans-serif; color: rgba(100,100,100,.16); z-index: -1 }
    .situacao, .serie { font-size: 9pt }
    .dados-livro { break-inside: avoid }
  </style></head><body class="${f.tipo === 'ATA' ? 'ata' : 'correspondencia'}">
  ${matriz ? '' : '<div class="rascunho">RASCUNHO</div>'}
  <header class="institucional">${logo}<strong>${escape(f.igreja.nome)}</strong>${f.contexto ? `<div>${escape(f.contexto)}</div>` : ''}
  ${estrutura ? blocos(estrutura.cabecalho) : ''}</header>
  <h1>${escape(f.titulo)} ${escape(f.numero)}</h1>
  ${matriz ? `<p class="centro situacao">Matriz aprovada${f.assinaturaSeparada ? '' : ' · Sem assinaturas'}</p>` : ''}
  ${apresentacao}${livro}<p class="direita">${local ? escape(local) + ', ' : ''}${escape(dataTexto)}.</p>
  ${f.assunto ? `<p><strong>Assunto:</strong> ${escape(f.assunto)}</p>` : ''}
  <main>${dadosTermo}${f.conteudo.teor ? `<p>${texto(f.conteudo.teor)}</p>` : ''}${estrutura ? blocos(estrutura.corpo) : ''}${htmlResolucoes(f.resolucoes ?? [])}</main>
  ${estrutura?.rodape.length ? `<footer>${blocos(estrutura.rodape)}</footer>` : ''}
  ${temAssinaturas ? '' : assinaturas()}</body></html>`;
}
async function comPrazo<T>(operacao: Promise<T>, prazo: number) {
  let timer: NodeJS.Timeout | undefined;
  return await Promise.race([
    operacao,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Tempo de renderização excedido.')), prazo); }),
  ]).finally(() => clearTimeout(timer));
}

function imprimirComLimite(page: import('playwright').Page, opcoes: Parameters<typeof page.pdf>[0]) {
  return comPrazo(page.pdf({ format: 'A4', printBackground: true, ...opcoes }), 30000);
}

async function fontesDocumento(composicao?: ComposicaoPagina) {
  const faces = new Map<string, { familia: string; peso: number; estilo: string }>();
  function registrar(familia: string, peso: number, estilo: string) {
    faces.set([familia, peso, estilo].join('/'), { familia, peso, estilo });
  }
  const padrao = composicao?.pagina.fonte ?? 'Noto';
  for (const peso of [400, 700]) for (const estilo of ['normal', 'italic']) registrar(padrao, peso, estilo);
  if (composicao) {
    const blocos = [...composicao.cabecalho, ...composicao.corpo, ...composicao.rodape];
    for (const b of paragrafos(blocos)) {
      for (const t of b.trechos) if ('fonte' in t && t.fonte) {
        registrar(t.fonte, t.negrito ? 700 : 400, t.italico ? 'italic' : 'normal');
      }
    }
  }
  const css = await Promise.all([...faces.values()].map(async ({ familia, peso, estilo }) => {
    let caminho: string;
    if (familia === 'Liberation Serif') {
      const face = peso === 700 ? (estilo === 'italic' ? 'bolditalic' : 'bold') : (estilo === 'italic' ? 'italic' : 'regular');
      caminho = `@universal-office/font-files/liberationserif-${face}.ttf`;
    } else {
      const nome = familia === 'Noto Sans' ? 'noto-sans' : 'noto-serif';
      caminho = `@fontsource/${nome}/files/${nome}-latin-${peso}-${estilo}.woff2`;
    }
    const bytes = await readFile(require.resolve(caminho));
    return `@font-face{font-family:"${familia}";src:url(data:font/${familia === 'Liberation Serif' ? 'ttf' : 'woff2'};base64,${bytes.toString('base64')});font-weight:${peso};font-style:${estilo}}`;
  }));
  return css.join('');
}

async function imprimirHtml(documento: string, opcoes: Parameters<import('playwright').Page['pdf']>[0], composicao?: ComposicaoPagina, arquivos: Record<string,string> = {}) {
  const pagina = composicao?.pagina;
  const html = documento.replace('<style>', '<style>' + await fontesDocumento(composicao));
  const bytesImagens = composicao?.versao_formato === 2 ? Object.values(arquivos).reduce((total, uri) => total + Buffer.byteLength(uri), 0) : 0;
  if (Buffer.byteLength(html) + bytesImagens > 16 * 1024 * 1024) throw new Error('Fonte de renderização excede o limite.');
  const browser = await chromium.launch({
    headless: true, timeout: 15000, chromiumSandbox: process.env.NODE_ENV === 'production',
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR'].includes(k))),
  });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
    if (await page.evaluate(() => Array.from(document.images).some(img => !img.naturalWidth))) throw new Error('Não foi possível decodificar uma das imagens.');
    if (pagina) {
      await page.emulateMedia({ media: 'print' });
      if (composicao?.versao_formato === 2) return await comPrazo(imprimirComposicao(page, composicao, arquivos, imprimirComLimite), 60000);
      const alturas = await page.evaluate(async () => {
        await document.fonts.ready;
        return ['header', 'footer'].map(tag => document.querySelector(tag)!.getBoundingClientRect().height);
      });
      const m = pagina.margens_cm, e = pagina.espacamento_cm.corpo;
      const topo = alturas[0] + e.superior * 96 / 2.54, base = alturas[1] + e.inferior * 96 / 2.54;
      if ((29.7 - m.superior - m.inferior) * 96 / 2.54 - topo - base < pagina.tamanho_pt * 96 / 72 * 1.45) {
        throw new Error('Reduza as margens ou o conteúdo fixo para que o corpo caiba na página.');
      }
      if (Object.keys(composicao!.notas).length) {
        const altura = (29.7 - m.superior - m.inferior) * 96 / 2.54 - topo - base;
        return await imprimirComNotas(page, composicao!, altura);
      }
      // Chromium recorta regiões fixas posicionadas nas margens de uma página
      // fragmentada. Imprimir as regiões uma vez e aplicá-las sobre cada folha
      // preserva fontes incorporadas, seleção de texto e posição física.
      const imprimir = () => imprimirComLimite(page, { preferCSSPageSize: true });
      const aplicar = (css: string) => page.evaluate(regras => {
        let style = document.getElementById('paginacao');
        if (!style) { style = document.createElement('style'); style.id = 'paginacao'; document.head.append(style); }
        style.textContent = regras;
      }, css);
      const cmPx = 96 / 2.54;
      await aplicar(`@page{size:A4;margin:${m.superior + topo/cmPx}cm ${m.direita}cm ${m.inferior + base/cmPx}cm ${m.esquerda}cm} header,footer{display:none}`);
      const corpo = await imprimir();
      if (!await page.evaluate(() => ['header','footer'].some(tag => document.querySelector(tag)?.textContent?.trim() || document.querySelector(tag + ' img, ' + tag + ' table')))) return corpo;
      await aplicar(`@page{size:A4;margin:0} body>:not(header):not(footer){display:none}
        header,footer{position:fixed;left:${m.esquerda}cm;right:${m.direita}cm}header{top:${m.superior}cm}footer{bottom:${m.inferior}cm}`);
      const regioes = await imprimir();
      const pdf = await PDFDocument.load(corpo);
      const [fixas] = await pdf.embedPdf(regioes, [0]);
      for (const folha of pdf.getPages()) folha.drawPage(fixas);
      return Buffer.from(await pdf.save());
    }
    return await imprimirComLimite(page, opcoes);
  } finally { await browser.close(); }
}

async function imprimirComNotas(page: import('playwright').Page, comp: ComposicaoPagina, altura: number) {
  await page.evaluate(estilo => {
    const css = document.createElement('style');
    css.textContent = '@page{size:A4;margin:0} main{display:flow-root} sup[data-nota]::before{content:"\u2060"} sup[data-nota]{font-size:.72em;line-height:0;vertical-align:baseline;position:relative;top:-.45em}';
    document.head.append(css);
    const main = document.querySelector('main')!;
    const selo = document.querySelector('body > small');
    if (selo) { const p = document.createElement('p'); p.append(selo); main.append(p); }
    const medidor = document.createElement('p');
    medidor.id = 'medidor-notas';
    medidor.style.cssText = estilo + ';position:absolute;visibility:hidden;width:' + getComputedStyle(main).width;
    document.body.append(medidor);
  }, estiloParteNota);
  const entrada = { corpo: 'main', medidor: '#medidor-notas', altura, notas: comp.notas };
  const folhas = await page.evaluate<FolhaNotas[], typeof entrada>(paginarNotas, entrada);
  await page.evaluate(({ folhas, config, estilo }) => {
    const main = document.querySelector('main')!;
    const topo = main.getBoundingClientRect().top;
    const blocos = Array.from(main.children, el => ({ el, y: el.getBoundingClientRect().top - topo, base: el.getBoundingClientRect().bottom - topo }));
    const header = document.querySelector('header')!, footer = document.querySelector('footer')!;
    const marca = document.querySelector('.rascunho');
    const paginas = document.createDocumentFragment();
    const m = config.margens_cm, e = config.espacamento_cm.corpo;
    for (const f of folhas) {
      const folha = document.createElement('section');
      folha.style.cssText = 'width:21cm;height:29.7cm;position:relative;display:flex;flex-direction:column;break-after:page;overflow:hidden;padding:' +
        [m.superior,m.direita,m.inferior,m.esquerda].map(n => n+'cm').join(' ');
      folha.append(header.cloneNode(true));
      const janela = document.createElement('div');
      janela.className = 'regiao';
      janela.style.cssText = 'position:relative;overflow:clip;flex:none;margin-top:'+e.superior+'cm;height:'+(f.fim-f.inicio)+'px';
      // Copiar apenas os blocos que intersectam a folha conserva a quebra de
      // linhas e a justificação original mesmo no meio de um parágrafo longo.
      for (const b of blocos) if (b.y < f.fim && b.base > f.inicio) {
        const copia = b.el.cloneNode(true) as HTMLElement;
        Object.assign(copia.style, { position:'absolute', margin:'0', left:'0', width:'100%', top:(b.y-f.inicio)+'px' });
        janela.append(copia);
      }
      folha.append(janela);
      const notas = document.createElement('aside');
      notas.style.cssText = 'margin-top:auto;padding-top:'+e.inferior+'cm';
      for (const parte of f.notas) {
        const p = document.createElement('p');
        p.style.cssText = estilo;
        p.textContent = parte.legenda + parte.texto;
        notas.append(p);
      }
      folha.append(notas, footer.cloneNode(true));
      if (marca) {
        const selo = marca.cloneNode(true) as HTMLElement;
        selo.style.position = 'absolute';
        folha.append(selo);
      }
      paginas.append(folha);
    }
    document.body.replaceChildren(paginas);
    (document.body.lastElementChild as HTMLElement).style.breakAfter = 'auto';
  }, { folhas, config: comp.pagina, estilo: estiloParteNota });
  return imprimirComLimite(page, { preferCSSPageSize: true });
}

export function imprimirComprovante(titulo: string, dados: string[], linhas: { nome: string; detalhe: string }[]) {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
  <style>
    body { font: 11pt/1.45 Noto, serif; overflow-wrap: anywhere }
    h1 { font-size: 17pt } h2 { font-size: 13pt }
    li { break-inside: avoid; margin-bottom: 3mm }
    p { margin-block: 2mm }
  </style></head><body><h1>${escape(titulo)}</h1>
  ${dados.map(v => `<p>${escape(v)}</p>`).join('')}
  <h2>Assinaturas registradas</h2><ul>${linhas.map(v => `<li><strong>${escape(v.nome)}</strong><br>${escape(v.detalhe)}</li>`).join('')}</ul>
  </body></html>`;
  return imprimirHtml(html, { margin: { top: '22mm', bottom: '22mm', left: '22mm', right: '22mm' } });
}

export const margensConcilio = { superior: 3, direita: 3, inferior: 3, esquerda: 3 };
export async function gerarPdf(f: FonteRenderizacao): Promise<Buffer> {
  if (f.livro?.perfil === 'CONCILIO_IPB_2025' && f.conteudo.composicao) {
    const comp = structuredClone(f.conteudo.composicao);
    comp.pagina.margens_cm = margensConcilio;
    f = { ...f, conteudo: { ...f.conteudo, composicao: comp } };
  }
  const endereco = [f.igreja.logradouro, f.igreja.numero, f.igreja.complemento, f.igreja.bairro, f.igreja.cidade, f.igreja.estado, f.igreja.cep].filter(Boolean).join(', ');
  const paginas = 'Pág. <span class="pageNumber"></span> de <span class="totalPages"></span>';
  const rodape = f.livro ? '<span></span>' : f.tipo === 'ATA'
    ? `<div style="font:10px sans-serif;width:100%;text-align:right;padding:0 20mm">${paginas}</div>`
    : `<div style="font:9px/1.25 sans-serif;width:100%;text-align:center;padding:0 20mm;overflow-wrap:anywhere">
        <div>${escape(endereco)}</div><div>${escape(f.igreja.nome)}${f.igreja.cnpj ? ' · CNPJ ' + escape(f.igreja.cnpj) : ''}</div>
        <div style="display:flex;justify-content:space-between;gap:4mm;text-align:left"><span>${escape(f.titulo)} ${escape(f.numero)}</span><span style="white-space:nowrap">${paginas}</span></div>
      </div>`;
  const margin = f.livro?.perfil === 'CONCILIO_IPB_2025'
    ? { top: '30mm', bottom: '30mm', left: '30mm', right: '30mm' }
    : f.tipo === 'ATA'
    ? { top: '25mm', bottom: '22mm', left: '30mm', right: '20mm' }
    : { top: '23mm', bottom: '32mm', left: '20mm', right: '20mm' };
  const header = f.finalidade === 'MATRIZ_APROVADA' ? '<span></span>' :
    '<div style="width:100%;text-align:center;color:#666;font:10px sans-serif">RASCUNHO</div>';
  const pdf = await imprimirHtml(htmlDocumento(f), f.conteudo.composicao ? { preferCSSPageSize: true } : {
    displayHeaderFooter: true, headerTemplate: header, footerTemplate: rodape, margin,
  }, f.conteudo.composicao, f.imagens);
  if (pdf.length > 10 * 1024 * 1024) throw new Error('PDF excede o limite.');
  if (!f.livro?.paginas) return pdf;
  const livro = f.livro;
  const matriz = await PDFDocument.load(pdf);
  if (matriz.getPageCount() !== livro.paginas) throw new Error('Renderização divergente da reserva.');
  if (livro.numeroVisivel == null) return pdf;
  const negrito = await matriz.embedFont(StandardFonts.TimesRomanBold);
  matriz.getPages().forEach((pagina, i) => {
    const numero = String(livro.numeroVisivel! + i);
    pagina.drawText(numero, { x: pagina.getWidth() - 85 - negrito.widthOfTextAtSize(numero, 12), y: 57, size: 12, font: negrito });
  });
  const paginado = Buffer.from(await matriz.save());
  if (paginado.length > 10 * 1024 * 1024) throw new Error('PDF excede o limite.');
  return paginado;
}

export async function medirPaginasLivro(pdf: Buffer, livro: FonteRenderizacao['livro']) {
  if (!livro || livro.paginas !== undefined) throw new Error('Fonte de medição inválida.');
  return (await PDFDocument.load(pdf)).getPageCount();
}
