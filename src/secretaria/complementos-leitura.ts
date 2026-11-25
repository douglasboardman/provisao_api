const escape = (v: string = '') =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
const apuracaoRotulos = {
  favoraveis: 'Favoráveis',
  contrarios: 'Contrários',
  abstencoes: 'Abstenções',
  impedimentos: 'Impedimentos',
  quorum: 'Quórum registrado',
} as const

export function htmlResolucoes(resolucoes: ResolucaoLeitura[]) {
  if (!resolucoes.length) return ''
  const paragrafo = (label: string, conteudo: string) =>
    `<p><strong>${label}</strong> ${escape(conteudo).replace(/\n/g, '<br>')}</p>`
  return `<section><h2>Resoluções</h2>${resolucoes
    .map((r) => {
      const campos = Object.keys(apuracaoRotulos) as (keyof typeof apuracaoRotulos)[]
      const apuracao = campos
        .filter((chave) => r.apuracao?.[chave] !== undefined)
        .map((chave) => `${apuracaoRotulos[chave]} ${r.apuracao?.[chave]}`)
        .join(' · ')
      return `<article><h3>${r.ordem}. ${escape(r.assunto)}</h3>
      ${paragrafo('Resultado', r.resultado)}
      ${r.proposta ? paragrafo('Texto proposto', r.proposta) : ''}
      ${r.deliberado ? paragrafo('Texto deliberado', r.deliberado) : ''}
      ${r.proponentes.length ? paragrafo('Proponentes', r.proponentes.join('; ')) : '<p>Sem proponente informado</p>'}
      ${r.dissidentes.length ? paragrafo('Dissidentes registrados', r.dissidentes.join('; ')) : ''}
      ${paragrafo('Eficácia', r.eficaz ? 'Registrada' + (r.dataEfeito ? ' · ' + r.dataEfeito.split('-').reverse().join('/') : '') : 'Sem efeito registrado')}
      ${r.secreta ? '<p>Votação secreta</p>' : ''}
      ${apuracao ? paragrafo('Apuração', apuracao) : ''}
    </article>`
    })
    .join('')}</section>`
}

export function htmlTermo(natureza: string | undefined, campos: Record<string, string>) {
  const abertura = natureza === 'ABERTURA'
  const encerramento = natureza === 'ENCERRAMENTO'
  const totalAtas = encerramento
    ? campos.TOTAL_ATAS === '1'
      ? 'Foi registrada 1 ata'
      : `Foram registradas ${escape(campos.TOTAL_ATAS)} atas`
    : ''
  return abertura || encerramento
    ? `<section class="dados-livro">
    <p>Livro nº ${escape(campos.NUMERO_LIVRO)} de ${escape(campos.TITULAR)}, ${escape(campos.MODALIDADE_LIVRO)}, com capacidade declarada de ${escape(campos.CAPACIDADE_FOLHAS)} folhas.</p>
    ${encerramento ? `<p>${totalAtas}. Utilização de ${escape(campos.PAGINAS_UTILIZADAS)} faces em ${escape(campos.FOLHAS_UTILIZADAS)} folhas, com saldo de ${escape(campos.SALDO_FACES)} faces e ${escape(campos.SALDO_FOLHAS)} folhas inteiramente sem conteúdo efetivado. Intervalo dos registros: ${escape(campos.INTERVALO_REGISTROS)}.</p><p>Motivo: ${escape(campos.MOTIVO_ENCERRAMENTO)}.</p>` : ''}
  </section>`
    : ''
}
export function htmlSignatarios(nomes: string[]) {
  return nomes.map((s) => '<div class="signatario"><span></span>' + escape(s) + '</div>').join('')
}

export interface ResolucaoLeitura {
  ordem: number
  assunto: string
  proposta?: string | null
  deliberado?: string | null
  resultado: string
  eficaz: boolean
  dataEfeito?: string | null
  secreta: boolean
  apuracao?: Partial<Record<keyof typeof apuracaoRotulos, number>> | null
  proponentes: string[]
  dissidentes: string[]
}
