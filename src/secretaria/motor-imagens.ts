import type { ImagemPaginaV2 } from './composicao-pagina'

export interface FaixaImagem {
  inicio: number
  fim: number
  altura: number
}

// Autocontido para uso também no Chromium de impressão, sem executar scripts do documento.
export function criarMotorImagens() {
  const pxPorCm = 96 / 2.54
  const horizontal = { esquerda: 0, centro: 0.5, direita: 1 }
  const vertical = { topo: 0, centro: 0.5, base: 1 }
  const ajustes = { original: 'none', ajustar: 'contain', preencher: 'cover', personalizado: 'fill' }
  const medir = new WeakMap<HTMLElement, (faixas?: readonly FaixaImagem[]) => void>()

  function medirImagens(folha: HTMLElement, faixas?: readonly FaixaImagem[]) {
    folha.querySelectorAll<HTMLElement>('[data-ocorrencia]').forEach((el) => medir.get(el)?.(faixas))
  }

  const estilosAplicados = new WeakMap<HTMLElement, Map<string, string>>()
  function estilo(el: HTMLElement, regras: Record<string, string>) {
    const anteriores = estilosAplicados.get(el) ?? new Map<string, string>()
    estilosAplicados.set(el, anteriores)
    for (const [nome, valor] of Object.entries(regras)) {
      const css = nome.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
      if (anteriores.get(css) === valor) continue
      anteriores.set(css, valor)
      el.style.setProperty(css, valor)
    }
  }
  const px = (n: number) => Math.round(n * 100) / 100 + 'px'

  // Amostra o alfa após aplicar o mesmo object-fit da imagem visível.
  // Uma linha do contorno usa a extremidade opaca voltada para o texto.
  function bordaAlfa(img: HTMLImageElement, w: number, h: number, ajuste: string, direita: boolean) {
    if (!img.naturalWidth) return
    const canvas = document.createElement('canvas')
    const escala = Math.min(1, 160 / Math.max(w, h))
    canvas.width = Math.max(1, Math.round(w * escala))
    canvas.height = Math.max(1, Math.round(h * escala))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    let dw = w,
      dh = h
    if (ajuste !== 'fill') {
      const fatores = [w / img.naturalWidth, h / img.naturalHeight]
      const k = ajuste === 'none' ? 1 : ajuste === 'cover' ? Math.max(...fatores) : Math.min(...fatores)
      dw = img.naturalWidth * k
      dh = img.naturalHeight * k
    }
    ctx.scale(canvas.width / w, canvas.height / h)
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
    try {
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      return Array.from({ length: canvas.height }, (_, y) => {
        for (let n = 0; n < canvas.width; n++) {
          const x = direita ? n : canvas.width - 1 - n
          if (data[4 * (y * canvas.width + x) + 3] > 127) return (w * (direita ? x : x + 1)) / canvas.width
        }
        return null
      })
    } catch {
      return undefined
    }
  }

  function vistaImagem(i: ImagemPaginaV2, src: string | null, host: HTMLElement, editavel: boolean) {
    const ancora = document.createElement('span')
    ancora.className = 'imagem-ancorada'
    ancora.dataset.ocorrencia = i.ocorrencia_id
    ancora.dataset.repeticao = i.repeticao ?? 'todas'
    ancora.contentEditable = 'false'
    const marca = document.createElement('span')
    marca.className = 'imagem-marca'
    const reserva = document.createElement('span')
    const caixa = document.createElement('span')
    caixa.className = 'imagem-caixa'
    caixa.dataset.imagemId = i.ocorrencia_id
    const img = document.createElement('img')
    img.crossOrigin = 'use-credentials'
    if (src) img.src = src
    img.alt = i.descricao
    img.draggable = false
    const fit = i.ajuste === 'personalizado' && i.manter_proporcao ? 'contain' : ajustes[i.ajuste]
    Object.assign(img.style, {
      width: i.largura_cm + 'cm',
      height: i.altura_cm + 'cm',
      objectFit: fit,
      opacity: String(i.opacidade),
    })
    caixa.append(img)
    if (i.legenda) {
      const legenda = document.createElement('span')
      legenda.className = 'imagem-legenda'
      legenda.textContent = i.legenda
      caixa.append(legenda)
    }
    const linha = i.relacao === 'em_linha'
    const livre = i.relacao === 'atras' || i.relacao === 'a_frente'
    ancora.classList.toggle('imagem-com-reserva', !linha && !livre)
    const fixa = host.dataset.editor !== 'corpo'
    const direita = i.horizontal === 'direita'
    ancora.classList.toggle('imagem-em-linha', linha)
    caixa.dataset.relacao = i.relacao
    // A área de interação pode ficar sobre o texto enquanto a marca-d'água permanece atrás.
    const manipulador = editavel && i.relacao === 'atras' ? document.createElement('span') : undefined
    if (manipulador) {
      manipulador.className = 'imagem-manipulador'
      manipulador.dataset.manipularId = i.ocorrencia_id
      host.parentElement!.querySelector('.imagens-frente')!.append(manipulador)
    }
    const alca = editavel ? document.createElement('span') : null
    if (alca) {
      alca.className = 'imagem-alca'
      alca.title = 'Redimensionar imagem'
      const alvo = manipulador ?? caixa
      alvo.append(alca)
    }
    ancora.append(marca, reserva)
    if (livre)
      host
        .parentElement!.querySelector(i.relacao === 'atras' ? '.imagens-fundo' : '.imagens-frente')!
        .append(caixa)
    else reserva.append(caixa)
    const w = i.largura_cm * pxPorCm,
      h = i.altura_cm * pxPorCm
    const distancia = i.distancia_texto_cm * pxPorCm
    estilo(caixa, { width: px(w) })
    if (linha) {
      reserva.className = 'imagem-na-linha'
      estilo(reserva, { width: px(w), marginInline: px(distancia) })
    } else if (!livre) {
      reserva.className = 'imagem-reserva'
      reserva.style.cssFloat = direita ? 'right' : 'left'
    }
    let contorno: ReturnType<typeof bordaAlfa>
    let fonteAmostrada = ''
    function dispor(faixas?: readonly FaixaImagem[]) {
      const area = host.getBoundingClientRect()
      if (!host.clientWidth || !area.width) return
      const zoom = area.width / host.clientWidth
      const largura = host.clientWidth
      const notas = host.closest('.com-notas')?.querySelector('.notas-da-folha')
      let altura = Math.min(
        host.clientHeight,
        notas ? Math.max(0, (notas.getBoundingClientRect().top - area.top) / zoom) : Infinity,
      )
      const a = marca.getBoundingClientRect()
      const naTela = (a.top - area.top) / zoom
      let top = naTela
      if (!fixa && faixas?.length) {
        const origem = (a.top - host.firstElementChild!.getBoundingClientRect().top) / zoom
        const faixa =
          faixas.find((f) => origem < f.fim - 0.01 && origem >= f.inicio - 0.5) ?? faixas[faixas.length - 1]
        top = origem - faixa.inicio
        if (!livre) altura = faixa.altura
      }
      const pagina = host.closest<HTMLElement>('.pagina-folha')!
      const mostrar = !fixa || i.repeticao !== 'primeira' || pagina.dataset.pagina === '1'
      const coluna = Math.max(0, Math.floor(((a.left - area.left) / zoom + host.scrollLeft + 0.01) / largura))
      const totalH = h + (caixa.querySelector<HTMLElement>('.imagem-legenda')?.offsetHeight ?? 0)
      function posicionarAlca(x: number, y: number) {
        if (!alca || manipulador) return
        estilo(alca, {
          right: px(Math.max(0, x + w - largura)),
          bottom: px(Math.max(0, y + totalH - altura)),
        })
      }
      if (linha) {
        // A medida da imagem não determina a altura do cabeçalho ou do rodapé.
        const limite = fixa
          ? Math.max(
              parseFloat(getComputedStyle(host).minHeight) || 0,
              parseFloat(getComputedStyle(host).lineHeight) || 0,
            )
          : altura
        estilo(reserva, { height: px(Math.min(totalH, limite)), maxWidth: '100%' })
        const rect = reserva.getBoundingClientRect()
        posicionarAlca((rect.left - area.left) / zoom, (rect.top - area.top) / zoom)
        return
      }
      const x = (largura - w) * horizontal[i.horizontal] + i.x_cm * pxPorCm
      const alinhamentoY = (altura - totalH) * vertical[i.vertical]
      const y = alinhamentoY + i.y_cm * pxPorCm
      if (livre) {
        const fimTexto = parseFloat(getComputedStyle(host).getPropertyValue('--altura-folha'))
        const nestaFolha =
          fixa ||
          (host.closest('.com-notas')
            ? naTela >= -0.5 && naTela < (Number.isFinite(fimTexto) ? fimTexto : altura)
            : coluna + 1 === Number(pagina.dataset.pagina))
        caixa.hidden = !mostrar || !nestaFolha
        const camada = caixa.parentElement!
        estilo(camada, { height: px(altura) })
        estilo(caixa, { left: px(x), top: px(y) })
        posicionarAlca(x, y)
        if (manipulador) {
          manipulador.hidden = caixa.hidden
          const sx = Math.max(0, x),
            sy = Math.max(0, y)
          estilo(manipulador, {
            left: px(sx),
            top: px(sy),
            width: px(Math.max(0, Math.min(largura, x + w) - sx)),
            height: px(Math.max(0, Math.min(altura, y + totalH) - sy)),
          })
        }
        return
      }
      // A reserva acompanha a coluna da âncora mesmo nas folhas fora da tela.
      const topoAncora = Math.max(0, top)
      const inicio = fixa ? y : Math.max(topoAncora, alinhamentoY) + i.y_cm * pxPorCm
      const limite = Math.max(0, altura - topoAncora)
      const inicioNaReserva = inicio - topoAncora
      const bloco = i.relacao === 'acima_abaixo'
      const intercepta = x < largura && x + w > 0 && inicio < altura && inicio + totalH > topoAncora
      const larguraReserva = !intercepta
        ? 0
        : bloco
          ? largura
          : Math.max(0, Math.min(largura, (direita ? largura - x : x + w) + distancia))
      const esquerdaReserva = direita ? largura - larguraReserva : 0
      const fim = intercepta ? Math.max(0, Math.min(limite, inicioNaReserva + totalH + distancia)) : 0
      const ponto = (cx: number, cy: number) => px(Math.max(0, Math.min(larguraReserva, cx))) + ' ' + px(cy)
      const lateral = direita ? larguraReserva : 0
      const extremo = direita ? 0 : larguraReserva
      const topoForma = Math.max(0, inicioNaReserva - distancia)
      const pontos = [ponto(lateral, topoForma)]
      if (i.relacao === 'atraves' && img.complete && img.naturalWidth && img.currentSrc !== fonteAmostrada) {
        contorno = bordaAlfa(img, w, h, fit, direita)
        fonteAmostrada = img.currentSrc
      }
      if (contorno) {
        for (let n = 0; n < contorno.length; n++) {
          const py = inicioNaReserva + (h * n) / contorno.length
          if (py >= fim) break
          const borda = contorno[n]
          pontos.push(ponto(borda === null ? lateral : x - esquerdaReserva + borda, py))
        }
        if (i.legenda && inicioNaReserva + h < fim)
          pontos.push(ponto(extremo, inicioNaReserva + h), ponto(extremo, fim))
      } else pontos.push(ponto(extremo, topoForma), ponto(extremo, fim))
      pontos.push(ponto(lateral, fim))
      const forma = !contorno && topoForma === 0 ? 'none' : 'polygon(' + pontos.join(',') + ')'
      estilo(reserva, {
        width: px(larguraReserva),
        height: px(fim),
        shapeOutside: forma,
        shapeMargin: px(contorno ? distancia : 0),
      })
      estilo(caixa, { left: px(x - esquerdaReserva), top: px(inicioNaReserva) })
      posicionarAlca(x, inicio)
    }
    medir.set(ancora, dispor)
    return {
      dom: ancora,
      ignoreMutation: () => true,
      destroy() {
        medir.delete(ancora)
        caixa.remove()
        manipulador?.remove()
      },
    }
  }
  return { pxPorCm, medirImagens, vistaImagem }
}
