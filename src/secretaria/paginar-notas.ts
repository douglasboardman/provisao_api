// Usado pelo Chromium de impressão e pelo editor. A cópia no outro aplicativo
// mantém os dois builds independentes. A prova integrada compara os dois arquivos.
export interface ParteNota { id: string; legenda: string; texto: string }
export interface FolhaNotas { inicio: number; fim: number; notas: ParteNota[] }
export const estiloParteNota = 'margin:0;border-top:1px solid #777;padding:2px 0 0;font-size:10pt;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left'

// Autocontida para também executar por page.evaluate no Chromium da API.
export function paginarNotas({ corpo: origem, medidor: medida, altura: alturaInicial, alturaDemais = alturaInicial, notas, fluxoImagens = false }: {
  corpo: HTMLElement | string; medidor: HTMLElement | string; altura: number; alturaDemais?: number; fluxoImagens?: boolean; notas: Record<string, { texto: string }>
}): FolhaNotas[] {
  let altura = alturaInicial
  const corpo = typeof origem === 'string' ? document.querySelector<HTMLElement>(origem)! : origem
  const medidor = typeof medida === 'string' ? document.querySelector<HTMLElement>(medida)! : medida
  const caixa = corpo.getBoundingClientRect()
  const escala = caixa.width / parseFloat(getComputedStyle(corpo).width) || 1
  const alturaCorpo = caixa.height / escala
  type Linha = { topo: number; base: number; ids: string[] }
  const retangulos: Linha[] = []
  function incluir(rect: DOMRect, id?: string) {
    if (rect.height <= 0) return
    retangulos.push({ topo: (rect.top - caixa.top) / escala, base: (rect.bottom - caixa.top) / escala, ids: id ? [id] : [] })
  }
  const walker = document.createTreeWalker(corpo, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  const quebras: number[] = []
  const range = document.createRange()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (fluxoImagens && n.parentElement?.closest('.imagem-caixa')) continue
    if (n instanceof HTMLElement) {
      if (fluxoImagens && n.matches('.imagem-na-linha,.imagem-marca')) incluir(n.getBoundingClientRect())
      if (n.classList.contains('quebra')) quebras.push((n.getBoundingClientRect().bottom - caixa.top) / escala)
      if (n.dataset.nota || n.tagName === 'IMG' || n.tagName === 'BR' || n.classList.contains('signatario')) incluir(n.getBoundingClientRect(), n.dataset.nota)
    } else if (!n.parentElement?.closest('[data-nota]')) {
      range.selectNodeContents(n)
      for (const rect of Array.from(range.getClientRects())) incluir(rect)
    }
  }
  // Marcas com fontes distintas e o sobrescrito podem ter caixas distintas na mesma linha.
  retangulos.sort((a, b) => a.topo - b.topo || b.base - a.base)
  const linhas: Linha[] = []
  for (const item of retangulos) {
    const ultima = linhas[linhas.length - 1]
    if (ultima && item.topo < ultima.base - 1) {
      ultima.base = Math.max(ultima.base, item.base)
      ultima.ids.push(...item.ids)
    } else linhas.push(item)
  }
  const numeros = new Map(Array.from(corpo.querySelectorAll<HTMLElement>('[data-nota]'), (n, i) => [n.dataset.nota!, i + 1]))
  function parte(id: string, texto: string, continuacao: boolean): ParteNota {
    return { id, texto, legenda: numeros.get(id) + (continuacao ? '. (continuação) ' : '. ') }
  }
  function medir(n: ParteNota) {
    medidor.textContent = n.legenda + n.texto
    return medidor.getBoundingClientRect().height / escala
  }
  const folhas: FolhaNotas[] = []
  let inicio = 0, fim = 0, rodape: ParteNota[] = [], ocupado = 0
  function virar() {
    folhas.push({ inicio, fim, notas: rodape })
    altura = alturaDemais
    inicio = fim
    ocupado = 0
    rodape = []
  }
  function inscrever(n: ParteNota, h: number) { rodape.push(n); ocupado += h }
  const impossivel = () => new Error('Reduza as margens, a fonte ou o conteúdo fixo para acomodar a linha e suas notas.')
  // Uma nota extensa começa junto à âncora. Se várias começam na mesma linha,
  // reserva ao menos o início de cada uma antes de repartir o espaço restante.
  function distribuir(partes: ParteNota[]) {
    while (partes.length) {
      const minimos = partes.map(n => medir({ ...n, texto: Array.from(n.texto)[0] }))
      let reserva = minimos.reduce((a, b) => a + b, 0)
      if (fim - inicio + ocupado + reserva > altura + 0.01) throw impossivel()
      const proximas: ParteNota[] = []
      partes.forEach((n, i) => {
        reserva -= minimos[i]
        const livre = altura - (fim - inicio) - ocupado - reserva
        const h = medir(n)
        if (h <= livre + 0.01) { inscrever(n, h); return }
        const letras = Array.from(n.texto)
        let a = 1, b = letras.length
        while (a < b) {
          const meio = Math.ceil((a + b) / 2)
          if (medir({ ...n, texto: letras.slice(0, meio).join('') }) <= livre + 0.01) a = meio
          else b = meio - 1
        }
        let texto = letras.slice(0, a).join('')
        const ultimoEspaco = texto.search(/\s+\S*$/u)
        if (ultimoEspaco > 0 && !/^\s/u.test(letras[a] ?? '')) texto = texto.slice(0, ultimoEspaco + 1)
        const atual = { ...n, texto }
        inscrever(atual, medir(atual))
        proximas.push(parte(n.id, n.texto.slice(texto.length), true))
      })
      partes = proximas
      if (partes.length) virar()
    }
  }
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i]
    while (quebras.length && quebras[0] <= linha.topo + 0.01) {
      quebras.shift()
      if (fim > inicio || ocupado) virar()
    }
    const limite = i + 1 < linhas.length ? (linha.base + linhas[i+1].topo) / 2 : alturaCorpo
    const novas = linha.ids.sort((a,b) => numeros.get(a)! - numeros.get(b)!).map(id => parte(id, notas[id].texto, false))
    const alturas = novas.map(medir)
    const soma = alturas.reduce((a,b) => a + b, 0)
    const parcial = limite - fim + soma > altura
    const necessario = parcial ? novas.reduce((h,n) => h + medir({ ...n, texto: Array.from(n.texto)[0] }), 0) : soma
    if (limite - inicio + ocupado + necessario > altura && (fim > inicio || ocupado)) virar()
    if (limite - inicio > altura + 0.01) throw impossivel()
    fim = limite
    if (limite - inicio + ocupado + soma <= altura) novas.forEach((n, j) => inscrever(n, alturas[j]))
    else distribuir(novas)
  }
  virar()
  return folhas
}
