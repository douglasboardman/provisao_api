import type { criarMotorImagens, FaixaImagem } from './motor-imagens'
import type { paginarNotas, FolhaNotas } from './paginar-notas'
import type { ComposicaoPagina as PaginaTexto } from './composicao-pagina'
type Regiao = 'cabecalho' | 'corpo' | 'rodape'
import type { ImagemPaginaV2 } from './composicao-pagina'

export const estiloLeitura = `
.leitura-paginada { position:relative; isolation:isolate; box-sizing:border-box; width:21cm;height:29.7cm;display:flex;flex-direction:column;background:white;color:#202027;line-height:1.45;overflow:clip;overflow-wrap:anywhere }
.leitura-paginada *, .leitura-paginada *::after {box-sizing:border-box}
.leitura-paginada .pagina-regiao {position:relative;flex:none;min-width:0}
.leitura-paginada .corpo {flex:1 1 0; min-height:0;display:flex;flex-direction:column}
.leitura-paginada .imagem-area {position:relative;isolation:isolate;overflow:clip;min-width:0}
.leitura-paginada .corpo>.imagem-area {flex:1;min-height:0;display:flex;flex-direction:column}
.leitura-paginada .pagina-visor {position:relative;z-index:1}
.leitura-paginada .corpo .pagina-visor {flex:1;min-height:0;overflow:clip;clip-path:inset(0 0 max(0px,calc(100% - var(--altura-folha,100%))) 0)}
.leitura-paginada .fluxo-leitura {display:flow-root;white-space:normal}
.leitura-paginada :is(p,h2,h3,.imagem-legenda) {white-space:pre-wrap}
.leitura-paginada .corpo .fluxo-leitura {transform:translateY(var(--inicio-folha,0px))}
.leitura-paginada :is(p,h2,h3,figure,ol,ul) {margin:0}
.leitura-paginada p {font:inherit;orphans:1;widows:1}
.leitura-paginada :is(h2,h3) {font-family:inherit;color:inherit;line-height:inherit}
.leitura-paginada h2 {font-size:1.35em}.leitura-paginada h3 {font-size:1.15em}
.leitura-paginada :is(h2,h3,strong,th) {font-weight:bold}
.leitura-paginada table {width:100%;border-collapse:collapse}.leitura-paginada :is(td,th){border:1px solid;padding:3px}
.leitura-paginada :is(ol,ul) {padding-inline-start:2em}.leitura-paginada ol {list-style:decimal}.leitura-paginada ul {list-style:disc}
.leitura-paginada figure img {display:block;max-width:100%;max-height:15cm}
.leitura-paginada .quebra {display:block;height:0;overflow:hidden;border:0}
.leitura-paginada [data-nota] {position:relative;top:-.45em;vertical-align:baseline;font-size:.72em;line-height:0}
.leitura-paginada [data-nota]::before {content:"\\2060"}.leitura-paginada [data-nota]::after {content:none}
.leitura-paginada .grupo-lista {display:block;margin-inline-start:1.3em;white-space:pre-line}
.leitura-paginada .notas-da-folha {position:absolute;bottom:0;left:0;right:0;background:white}
.leitura-paginada .medidor-notas {position:absolute;visibility:hidden;left:0;right:0;top:0}
.leitura-paginada .imagens-fundo,.leitura-paginada .imagens-frente {position:absolute;inset:0;overflow:clip;pointer-events:none}
.leitura-paginada .imagens-frente {z-index:2}
.leitura-paginada .imagem-ancorada {display:contents}.leitura-paginada .imagem-marca {display:inline-block;width:0;height:1px;vertical-align:top}
.leitura-paginada .imagem-com-reserva>.imagem-marca {position:absolute}
.leitura-paginada .imagem-na-linha {display:inline-block;position:relative;vertical-align:top;overflow:clip}
.leitura-paginada :is(.cabecalho,.rodape) .imagem-na-linha {overflow:visible}
.leitura-paginada .imagem-reserva {display:block;position:relative;overflow:clip}
.leitura-paginada .imagem-caixa {position:absolute;display:block}.leitura-paginada .imagem-caixa[hidden]{display:none}
.leitura-paginada .imagem-caixa img {display:block;max-width:none;max-height:none}
.leitura-paginada .imagem-legenda {display:block}
.leitura-paginada:not([data-pagina="1"]) :is(.cabecalho,.rodape) [data-repeticao="primeira"] {display:none}
.leitura-paginada .signatario {text-align:center;margin:12mm 0 3mm}.leitura-paginada .signatario span {display:block;width:64mm;border-top:1px solid;margin:0 auto 2mm}
`

export interface EntradaLeitura {
  pagina: PaginaTexto['pagina']
  notas: PaginaTexto['notas']
  imagens: ImagemPaginaV2[]
  arquivos: Record<string, string>
  estiloNota: string
}

// Os parâmetros DOM e as duas funções são fornecidos pelo navegador ou pelo worker.
// O fluxo contínuo permite cortar um parágrafo entre folhas preservando sua justificação.
export async function montarLeitura(
  alvo: HTMLElement,
  conteudo: Record<Regiao, DocumentFragment>,
  entrada: EntradaLeitura,
  motor: ReturnType<typeof criarMotorImagens>,
  paginar: typeof paginarNotas,
) {
  const { pagina: config, notas, estiloNota } = entrada
  function elemento(tag: string, classe: string, pai: HTMLElement) {
    const el = document.createElement(tag)
    el.className = classe
    pai.append(el)
    return el
  }
  const folha = elemento('article', 'pagina-folha leitura-paginada', alvo)
  const m = config.margens_cm
  Object.assign(folha.style, {
    fontFamily: config.fonte,
    fontSize: config.tamanho_pt + 'pt',
    padding: [m.superior, m.direita, m.inferior, m.esquerda].map((n) => n + 'cm').join(' '),
  })
  folha.dataset.pagina = '1'
  const imagens = new Map(entrada.imagens.map((i) => [i.ocorrencia_id, i]))
  for (const r of ['cabecalho', 'corpo', 'rodape'] as const) {
    const regiao = elemento('div', 'pagina-regiao ' + r + (r === 'corpo' ? ' com-notas' : ''), folha)
    const e = config.espacamento_cm[r]
    regiao.style.paddingBlock = e.superior + 'cm ' + e.inferior + 'cm'
    const area = elemento('div', 'imagem-area', regiao)
    elemento('div', 'imagens-fundo', area)
    const visor = elemento('div', 'pagina-visor', area)
    visor.dataset.editor = r
    visor.setAttribute('role', 'region')
    visor.setAttribute('aria-label', { cabecalho: 'Cabeçalho', corpo: 'Corpo', rodape: 'Rodapé' }[r])
    if (r !== 'corpo')
      visor.style.minHeight = (('altura_minima_cm' in config ? config.altura_minima_cm?.[r] : 0) ?? 0) + 'cm'
    elemento('div', 'imagens-frente', area)
    const fluxo = elemento('div', 'fluxo-leitura', visor)
    fluxo.append(conteudo[r])
    fluxo.querySelectorAll('.quebra').forEach((quebra) => quebra.replaceChildren())
    if (!fluxo.children.length) fluxo.append(document.createElement('p'))
    fluxo.querySelectorAll('p:empty').forEach((p) => p.append(document.createElement('br')))
    for (const marcador of fluxo.querySelectorAll<HTMLElement>('[data-ocorrencia]')) {
      const i = imagens.get(marcador.dataset.ocorrencia!)
      if (!i || !entrada.arquivos[i.arquivo_id]) throw Error('Imagem da composição indisponível.')
      marcador.replaceWith(motor.vistaImagem(i, entrada.arquivos[i.arquivo_id], visor, false).dom)
    }
  }
  const corpo = folha.querySelector<HTMLElement>('.corpo')!
  const visor = corpo.querySelector<HTMLElement>('.pagina-visor')!
  const fluxo = visor.firstElementChild as HTMLElement
  fluxo.querySelectorAll<HTMLElement>('[data-nota]').forEach((el, n) => {
    el.textContent = String(n + 1)
  })
  const medidor = elemento('p', 'medidor-notas', corpo)
  medidor.style.cssText = estiloNota
  const rodapeNotas = elemento('aside', 'notas-da-folha', corpo)
  rodapeNotas.setAttribute('aria-label', 'Notas desta página')
  rodapeNotas.style.bottom = config.espacamento_cm.corpo.inferior + 'cm'
  try {
    await Promise.all(Array.from(folha.querySelectorAll('img'), (img) => img.decode()))
  } catch {
    throw Error('Não foi possível carregar uma imagem da composição.')
  }
  folha.getBoundingClientRect() // Solicita as fontes em uso antes de medir o texto.
  await document.fonts.ready
  if (!folha.isConnected) throw Error('A prévia foi fechada.')
  function alturaDisponivel(numero: number) {
    folha.dataset.pagina = String(numero)
    motor.medirImagens(folha)
    return (
      visor.getBoundingClientRect().height /
      (folha.getBoundingClientRect().width / parseFloat(getComputedStyle(folha).width))
    )
  }
  const alturaDemais = alturaDisponivel(2),
    altura = alturaDisponivel(1)
  if (Math.min(altura, alturaDemais) < ((config.tamanho_pt * 96) / 72) * 1.45 - 1)
    throw Error('Reduza as margens ou o conteúdo fixo para que o corpo caiba na página.')
  let faixas: FaixaImagem[] = []
  let paginas: FolhaNotas[] = []
  function notasDaPagina(f: FolhaNotas) {
    rodapeNotas.replaceChildren(
      ...f.notas.map((n) => {
        const p = document.createElement('p')
        p.style.cssText = estiloNota
        p.textContent = n.legenda + n.texto
        return p
      }),
    )
  }
  for (let tentativa = 0; tentativa < 12; tentativa++) {
    paginas = paginar({ corpo: fluxo, medidor, altura, alturaDemais, notas, fluxoImagens: true })
    const zoom = folha.getBoundingClientRect().width / parseFloat(getComputedStyle(folha).width)
    const proximas = paginas.map((f, n) => {
      notasDaPagina(f)
      return {
        inicio: f.inicio,
        fim: f.fim,
        altura: (n ? alturaDemais : altura) - rodapeNotas.getBoundingClientRect().height / zoom,
      }
    })
    rodapeNotas.replaceChildren()
    if (JSON.stringify(proximas) === JSON.stringify(faixas)) break
    if (tentativa === 11)
      throw Error('A posição das imagens impede uma paginação estável. Ajuste o tamanho ou a disposição.')
    faixas = proximas
    motor.medirImagens(folha, faixas)
  }
  function mostrar(numero: number) {
    const f = paginas[numero - 1]
    folha.dataset.pagina = String(numero)
    corpo.style.setProperty('--inicio-folha', -f.inicio + 'px')
    corpo.style.setProperty('--altura-folha', Math.max(0, f.fim - f.inicio) + 'px')
    notasDaPagina(f)
    motor.medirImagens(folha, faixas)
  }
  medidor.remove()
  mostrar(1)
  return { folha, total: paginas.length, mostrar }
}
