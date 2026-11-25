import { PDFDocument } from 'pdf-lib'
import type { Page } from 'playwright'
import { criarMotorImagens } from './motor-imagens'
import { montarLeitura, estiloLeitura } from './leitura-paginada'
import { paginarNotas, estiloParteNota } from './paginar-notas'
import { paragrafos, type ComposicaoPaginaV2 } from './composicao-pagina'

type Imprimir = (page: Page, opcoes: Parameters<Page['pdf']>[0]) => Promise<Buffer>

export async function imprimirComposicao(
  page: Page,
  comp: ComposicaoPaginaV2,
  arquivos: Record<string, string>,
  imprimir: Imprimir,
) {
  const imagens = paragrafos([...comp.cabecalho, ...comp.corpo, ...comp.rodape]).flatMap((p) =>
    p.trechos.filter((t) => t.tipo === 'imagem'),
  )
  for (const i of imagens) {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(arquivos[i.arquivo_id] ?? ''))
      throw Error('Imagem privada indisponível.')
  }
  // Somente funções do pacote da API atravessam esta fronteira. Os dados do documento
  // são parâmetros estruturados. A página continua com scripts e rede desabilitados.
  const motor = await page.evaluateHandle(criarMotorImagens)
  const montar = await page.evaluateHandle<typeof montarLeitura>('(' + montarLeitura.toString() + ')')
  const paginar = await page.evaluateHandle<typeof paginarNotas>('(' + paginarNotas.toString() + ')')
  const leitura = await page.evaluateHandle(
    async ({ motor, montar, paginar, entrada, css }) => {
      const conteudo = (tag: string) => {
        const fragmento = document.createDocumentFragment()
        fragmento.append(...document.querySelector(tag)!.childNodes)
        return fragmento
      }
      const blocos = { cabecalho: conteudo('header'), corpo: conteudo('main'), rodape: conteudo('footer') }
      const selo = document.querySelector<HTMLElement>('body > small, body > .rascunho')
      document.body.replaceChildren()
      const estilo = document.createElement('style')
      estilo.textContent =
        css +
        '@page{size:A4;margin:0}body{margin:0;width:21cm}.leitura-paginada{break-after:page;break-inside:avoid}.leitura-paginada:last-child{break-after:auto}' +
        '.leitura-paginada>.rascunho{position:absolute;pointer-events:none;z-index:3}.selo-matriz{position:absolute;bottom:4mm;right:8mm;font:8pt sans-serif}'
      document.head.append(estilo)
      const doc = await montar(document.body, blocos, entrada, motor, paginar)
      if (selo) {
        if (selo.tagName === 'SMALL') selo.className = 'selo-matriz'
        doc.folha.append(selo)
      }
      return doc
    },
    {
      motor,
      montar,
      paginar,
      entrada: { pagina: comp.pagina, notas: comp.notas, imagens, arquivos, estiloNota: estiloParteNota },
      css: estiloLeitura,
    },
  )

  // Limita as cópias simultâneas do fluxo para atas extensas. O Chromium conserva
  // fontes, texto selecionável e contornos vetoriais dentro de cada janela A4.
  const { total, lote } = await leitura.evaluate((l) => ({
    total: l.total,
    lote: Math.max(1, Math.min(32, Math.floor(30000 / (1 + l.folha.querySelectorAll('*').length)))),
  }))
  const unido = await PDFDocument.create()
  for (let inicio = 1; inicio <= total; inicio += lote) {
    const fim = Math.min(total, inicio + lote - 1)
    await leitura.evaluate(
      (l, { inicio, fim }) => {
        document.body.replaceChildren(l.folha)
        const fragmento = document.createDocumentFragment()
        for (let n = inicio; n <= fim; n++) {
          l.mostrar(n)
          fragmento.append(l.folha.cloneNode(true))
        }
        document.body.replaceChildren(fragmento)
      },
      { inicio, fim },
    )
    const bytes = await imprimir(page, { preferCSSPageSize: true })
    const pdf = await PDFDocument.load(bytes)
    if (pdf.getPageCount() !== fim - inicio + 1)
      throw Error('A quantidade de folhas impressas diverge da prévia.')
    if (fim === total && inicio === 1) return bytes
    for (const p of await unido.copyPages(pdf, pdf.getPageIndices())) unido.addPage(p)
  }
  return Buffer.from(await unido.save())
}
