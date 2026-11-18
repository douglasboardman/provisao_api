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
const apuracaoRotulos = {
  favoraveis: 'Favoráveis', contrarios: 'Contrários', abstencoes: 'Abstenções',
  impedimentos: 'Impedimentos', quorum: 'Quórum registrado',
} as const;

function htmlResolucoes(resolucoes: NonNullable<FonteRenderizacao['resolucoes']>) {
  if (!resolucoes.length) return '';
  const paragrafo = (label: string, conteudo: string) =>
    `<p><strong>${label}</strong> ${escape(conteudo).replace(/\n/g, '<br>')}</p>`;
  return `<section><h2>Resoluções</h2>${resolucoes.map(r => {
    const campos = Object.keys(apuracaoRotulos) as (keyof typeof apuracaoRotulos)[];
    const apuracao = campos.filter(chave => r.apuracao?.[chave] !== undefined)
      .map(chave => `${apuracaoRotulos[chave]} ${r.apuracao?.[chave]}`).join(' · ');
    return `<article><h3>${r.ordem}. ${escape(r.assunto)}</h3>
      ${paragrafo('Resultado', r.resultado)}
      ${r.proposta ? paragrafo('Texto proposto', r.proposta) : ''}
      ${r.deliberado ? paragrafo('Texto deliberado', r.deliberado) : ''}
      ${r.proponentes.length ? paragrafo('Proponentes', r.proponentes.join('; ')) : '<p>Sem proponente informado</p>'}
      ${r.dissidentes.length ? paragrafo('Dissidentes registrados', r.dissidentes.join('; ')) : ''}
      ${paragrafo('Eficácia', r.eficaz ? 'Registrada' + (r.dataEfeito ? ' · ' + r.dataEfeito.split('-').reverse().join('/') : '') : 'Sem efeito registrado')}
      ${r.secreta ? '<p>Votação secreta</p>' : ''}
      ${apuracao ? paragrafo('Apuração', apuracao) : ''}
    </article>`;
  }).join('')}</section>`;
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
    return f.signatarios.map(s => '<div class="signatario"><span></span>' + escape(s) + '</div>').join('');
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
  const campos = f.conteudo.campos;
  const abertura = f.livro?.natureza === 'ABERTURA';
  const encerramento = f.livro?.natureza === 'ENCERRAMENTO';
  const totalAtas = encerramento
    ? (campos.TOTAL_ATAS === '1' ? 'Foi registrada 1 ata' : `Foram registradas ${escape(campos.TOTAL_ATAS)} atas`)
    : '';
  const dadosTermo = abertura || encerramento ? `<section class="dados-livro">
    <p>Livro nº ${escape(campos.NUMERO_LIVRO)} de ${escape(campos.TITULAR)}, ${escape(campos.MODALIDADE_LIVRO)}, com capacidade declarada de ${escape(campos.CAPACIDADE_FOLHAS)} folhas.</p>
    ${encerramento ? `<p>${totalAtas}. Utilização de ${escape(campos.PAGINAS_UTILIZADAS)} faces em ${escape(campos.FOLHAS_UTILIZADAS)} folhas, com saldo de ${escape(campos.SALDO_FACES)} faces e ${escape(campos.SALDO_FOLHAS)} folhas inteiramente sem conteúdo efetivado. Intervalo dos registros: ${escape(campos.INTERVALO_REGISTROS)}.</p><p>Motivo: ${escape(campos.MOTIVO_ENCERRAMENTO)}.</p>` : ''}
  </section>` : '';
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
async function imprimirHtml(documento: string, opcoes: Parameters<import('playwright').Page['pdf']>[0]) {
  const fontes = await Promise.all([400, 700].flatMap(peso => ['normal', 'italic'].map(async estilo => {
    const bytes = await readFile(require.resolve(`@fontsource/noto-serif/files/noto-serif-latin-${peso}-${estilo}.woff2`));
    return `@font-face{font-family:Noto;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2');font-weight:${peso};font-style:${estilo}}`;
  })));
  const html = documento.replace('<style>', '<style>' + fontes.join(''));
  if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error('Fonte de renderização excede o limite.');
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
    const imagensComFalha = await page.evaluate(() => Array.from(document.images).some(img => !img.naturalWidth));
    if (imagensComFalha) throw new Error('Não foi possível decodificar uma das imagens.');
    let timer: NodeJS.Timeout | undefined;
    return await Promise.race([
      page.pdf({ format: 'A4', printBackground: true, ...opcoes }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Tempo de renderização excedido.')), 30000); }),
    ]).finally(() => clearTimeout(timer));
  } finally { await browser.close(); }
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

export async function gerarPdf(f: FonteRenderizacao): Promise<Buffer> {
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
  const pdf = await imprimirHtml(htmlDocumento(f), {
    displayHeaderFooter: true, headerTemplate: header, footerTemplate: rodape, margin,
  });
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
