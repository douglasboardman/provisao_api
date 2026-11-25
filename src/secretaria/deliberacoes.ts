import { resultadosResolucao, type ResolucaoInput } from './resolucoes.dto'

// A mesma composição textual é usada no editor e no retrato congelado da ata.
export function textosDeliberacoes(rs: readonly ResolucaoInput[], nome: (id: string) => string) {
  const nomes = (ids: string[]) => ids.map(nome).sort((a,b) => a.localeCompare(b, 'pt-BR')).join(', ')
  return [...rs].sort((a,b) => a.ordem - b.ordem).map(r => {
    const partes = [r.assunto, resultadosResolucao[r.resultado]]
    if (r.texto_proposta && r.texto_deliberado && r.texto_proposta !== r.texto_deliberado)
      partes.push('Proposta original: ' + r.texto_proposta)
    const teor = r.texto_deliberado || r.texto_proposta
    if (teor) partes.push(teor)
    if (r.proponentes_pessoas_ids.length) partes.push('Proponentes: ' + nomes(r.proponentes_pessoas_ids))
    if (r.votacao_secreta) partes.push('Votação secreta')
    else if (r.dissidentes_pessoas_ids.length) partes.push('Dissidentes: ' + nomes(r.dissidentes_pessoas_ids))
    const rotulos = { favoraveis: 'Favoráveis', contrarios: 'Contrários', abstencoes: 'Abstenções', impedimentos: 'Impedimentos', quorum: 'Quórum' }
    for (const chave of Object.keys(rotulos) as (keyof typeof rotulos)[]) {
      const total = r.apuracao?.[chave]
      if (total !== undefined) partes.push(rotulos[chave] + ': ' + total)
    }
    if (r.eficaz) partes.push(r.data_efeito ? 'Efeito em ' + r.data_efeito.slice(0,10).split('-').reverse().join('/') : 'Eficácia registrada')
    return partes.join(' — ')
  })
}
