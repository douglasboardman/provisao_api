import { ehCampoNumeracao } from './numeracao-campos';
import { itensCampo, ocorrencias, textosPagina } from './composicao-pagina';
import { cargosDoArrolado, type ConfiguracaoModelo, type ReuniaoInput, type VersaoInput } from './secretaria.dto';

export interface PendenciaTramitacao { destino: string; mensagem: string }

export function pendenciasConteudo(config: ConfiguracaoModelo, conteudo: VersaoInput['conteudo'], motivador: string | null, totalResolucoes: number, aguardandoNumero = false) {
  const pendencias: PendenciaTramitacao[] = [];
  const mensagens = new Set<string>();
  function incluir(destino: string, mensagem: string) {
    const chave = destino + '/' + mensagem;
    if (!mensagens.has(chave)) pendencias.push({ destino, mensagem });
    mensagens.add(chave);
  }
  const textos = Object.values(conteudo.estrutura ?? {}).flat().flatMap(b =>
    b.tipo === 'TEXTO' ? [b.texto] : b.tipo === 'LISTA' ? b.itens : b.tipo === 'TABELA' ? b.linhas.flat() : []);
  textos.push(conteudo.teor, ...textosPagina(conteudo.composicao));
  const seraNumerado = (id: string) => aguardandoNumero && ehCampoNumeracao(config.definicoes?.[id]?.origem);
  const temCampo = ocorrencias(conteudo.composicao).some(c => seraNumerado(c.campo_id) || itensCampo(c, conteudo.valores).length);
  if (!temCampo && !totalResolucoes && !textos.some(t => t.trim())) incluir('teor', 'Teor obrigatório para encaminhar/aprovar.');
  for (const id of config.obrigatorios_biblioteca ?? []) {
    if (!seraNumerado(id) && !itensCampo({ tipo: 'campo', campo_id: id, apresentacao: 'em_linha' }, conteudo.valores).length) {
      incluir(config.definicoes?.[id]?.origem === 'redator_ata' ? 'redator-ata' : 'valor-' + id, 'Campo obrigatório: ' + config.definicoes?.[id]?.nome + '.');
    }
  }
  const campos = new Set(config.campos_obrigatorios);
  for (const texto of textos) {
    const padrao = /\{\{([^{}]*)\}\}/g;
    if (/\{\{|\}\}/.test(texto.replace(padrao, ''))) incluir('teor', 'Use {{CODIGO}} para inserir um campo.');
    for (const m of texto.matchAll(padrao)) {
      if (/^[A-Z][A-Z0-9_]{0,79}$/.test(m[1])) campos.add(m[1]);
      else incluir('teor', 'Marcador inválido: ' + m[1].slice(0, 80) + '.');
    }
  }
  for (const k of campos) if (!conteudo.campos[k]?.trim()) incluir('campo-' + k, 'Campo obrigatório: ' + k + '.');
  if (config.motivador === 'OBRIGATORIO' && !motivador) incluir('motivador', 'Motivador obrigatório.');
  if (config.resolucoes === 'OBRIGATORIO' && !totalResolucoes) incluir('resolucoes', 'Modelo exige ao menos uma resolução.');
  const obrigatorios = conteudo.arrolados.filter(p => p.assina && p.obrigatorio);
  if (!obrigatorios.length) incluir('arrolados', 'Indique ao menos um signatário obrigatório.');
  if (!conteudo.arrolados.some(p => p.responsavel)) incluir('arrolados', 'Indique o responsável pelo documento.');
  for (const papel of config.papeis_obrigatorios) if (!obrigatorios.some(p => p.papeis.includes(papel))) incluir('arrolados', 'Signatário obrigatório para papel ' + papel + '.');
  if (config.cargos_obrigatorios.some(id => !obrigatorios.some(p => cargosDoArrolado(p).includes(id)))) incluir('arrolados', 'Signatário de cargo exigido ausente.');
  if (conteudo.arrolados.some(p => (p.assina || p.responsavel) && !p.fundamento)) incluir('arrolados', 'Documente o fundamento de cada signatário e responsável.');
  return pendencias;
}

export function pendenciasMesa(dados: ReuniaoInput, participantes: { presente: boolean; papeis: string[] }[], minuta?: VersaoInput['conteudo']): PendenciaTramitacao[] {
  const presentes = participantes.filter(p => p.presente);
  const mensagens: string[] = [];
  if (dados.situacao && !['EM_ANDAMENTO', 'ENCERRADA'].includes(dados.situacao))
    mensagens.push('Registre a realização da reunião antes de formalizar a ata.');
  if (!dados.quorum_conferido || presentes.length < dados.quorum_minimo) mensagens.push('Quórum da reunião deve ser conferido e atendido.');
  for (const papel of ['PRESIDENTE', 'SECRETARIO']) if (!presentes.some(p => p.papeis.includes(papel))) mensagens.push('Mesa exige ' + papel + ' presente.');
  if (minuta && !dados.fim) mensagens.push('Informe o horário efetivo de encerramento da reunião.');
  const pendencias = mensagens.map(mensagem => ({ destino: 'mesa', mensagem }));
  if (minuta && !minuta.redator_ata) pendencias.push({ destino: 'redator-ata', mensagem: 'Selecione o redator da ata.' });
  return pendencias;
}

type Presenca = { presente: boolean; pessoa_id: string; papeis: string[]; retrato: unknown };
export function pendenciasAssinaturasReuniao(politica: ConfiguracaoModelo['assinaturas_reuniao'], participantes: Presenca[], conteudo: VersaoInput['conteudo']) {
  const pendencias: PendenciaTramitacao[] = [];
  if (!politica || politica === 'CARGOS') return pendencias;
  const presentes = participantes.filter(p => p.presente);
  const mesa = ['PRESIDENTE', 'SECRETARIO'];
  for (const papel of mesa) if (presentes.filter(p => p.papeis.includes(papel)).length !== 1)
    pendencias.push({ destino: 'mesa', mensagem: 'Confirme um único titular presente para ' + papel + ' da mesa.' });
  const porPessoa = new Map(conteudo.arrolados.map(p => [p.pessoa_id,p]));
  for (const p of presentes) {
    const papeisMesa = p.papeis.filter(papel => mesa.includes(papel));
    if (politica === 'MESA' && !papeisMesa.length) continue;
    const arrolado = porPessoa.get(p.pessoa_id);
    if (!arrolado?.assina || !arrolado.obrigatorio || papeisMesa.some(papel => !arrolado.papeis.includes(papel))) {
      pendencias.push({ destino: 'arrolados', mensagem: 'Inclua ' + (p.retrato as { nome: string }).nome + ' como signatário obrigatório' +
        (papeisMesa.length ? ' com o papel de ' + papeisMesa.join(' e ') : '') + '.' });
    }
  }
  return pendencias;
}
