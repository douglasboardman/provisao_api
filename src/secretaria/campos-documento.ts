import { contextoPorExtenso } from './contexto-por-extenso';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { livro_atas } from '@prisma/client';
import { textosDeliberacoes } from './deliberacoes';
import { numeroPorExtenso } from '../core/numero-por-extenso';
import { ocorrencias, valoresPaginaSchema, type ValoresPagina } from './composicao-pagina';
import { camposEndereco } from './local-reuniao';
import { horarioCivilPorExtenso } from './horario-reuniao';
import { validar, type ConfiguracaoModelo, type VersaoInput } from './secretaria.dto';
import type { Tx } from './secretaria-base.service';
import type { SecretariaCadastrosService } from './secretaria-cadastros.service';

type Reuniao = Awaited<ReturnType<SecretariaCadastrosService['reuniao']>>;
type Fontes = {
  contexto?: { id: string; nome: string; sigla: string };
  reuniao?: Reuniao; livro?: livro_atas; previsto: boolean; planejamento?: string;
  secretarioLivro?: string; preparador?: string | null; convocante?: string | null; atualizar?: boolean;
};
type Retrato = { cadastro: string; registro_id?: string; revisao?: number; atualizado_em?: string };

export function assinaturaFontes(v: VersaoInput) {
  const automaticos = Object.entries(v.conteudo.valores ?? {}).filter(([, x]) => x.origem.tipo === 'sistema').sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([automaticos, v.conteudo.planejamento_origem])).digest('hex');
}

export async function prepararCampos(tx: Tx, igreja_id: string, config: ConfiguracaoModelo, v: VersaoInput,
  fontes: Fontes, copiados: ValoresPagina, numero: number | null, anterior?: { conteudo: unknown; modelo_versao_id: string | null; reuniao_id: string | null }) {
  const definicoes = config.definicoes ?? {};
  const valores = v.conteudo.valores ?? {};
  const usos = ocorrencias(v.conteudo.composicao);
  if (Object.keys(valores).some(id => !definicoes[id]) || usos.some(c => !definicoes[c.campo_id] ||
    (!definicoes[c.campo_id].multiplo && (c.apresentacao !== 'individual' || c.indice)))) {
    throw new BadRequestException('Campo ou apresentação incompatível com a versão do modelo.');
  }
  const salvo = anterior?.conteudo as VersaoInput['conteudo'] | undefined;
  const salvos = anterior?.modelo_versao_id === v.modelo_versao_id ? salvo?.valores : undefined;
  v.conteudo.autores_origem = { preparador: fontes.preparador ?? salvo?.autores_origem?.preparador ?? null,
    convocante: salvo?.autores_origem?.convocante ?? fontes.convocante ?? null };
  const r = fontes.reuniao, l = fontes.livro;
  const dados = r?.dados as { data: string; horario_previsto?: string; local: string } | undefined;
  const endereco = (fontes.previsto ? r?.local_retrato : r?.local_efetivo_retrato ?? r?.local_retrato) as Record<string,string> | undefined;
  const pessoas = r?.participantes.filter(p => p.presente) ?? [];
  const nome = (p: typeof pessoas[number]) => (p.retrato as {nome: string}).nome;
  function mesa(papel: string) {
    const candidatos = pessoas.filter(p => p.papeis.includes(papel));
    return candidatos.length === 1 ? nome(candidatos[0]) : null;
  }
  const valoresFonte: Record<string, unknown> = {
    'contexto.nome': fontes.contexto?.nome, 'contexto.sigla': fontes.contexto?.sigla,
    'documento.assunto': v.assunto, 'documento.data_documento': v.data_documento,
    'documento.numero': numero, 'documento.numero.por_extenso': numero === null ? null : numeroPorExtenso(numero),
    'reuniao.data': dados?.data, 'reuniao.data.dia_por_extenso': r?.dia_reuniao_por_extenso,
    'reuniao.data.mes_por_extenso': r?.mes_reuniao_por_extenso, 'reuniao.data.ano_por_extenso': r?.ano_reuniao_por_extenso,
    'reuniao.horario_previsto': dados?.horario_previsto, 'reuniao.horario_previsto.hora_por_extenso': horarioCivilPorExtenso(dados?.horario_previsto),
    'reuniao.inicio.hora_local': r?.horario_inicio_reuniao, 'reuniao.inicio.hora_local_extenso': r?.horario_inicio_reuniao_por_extenso,
    'reuniao.fim.hora_local': r?.horario_encerramento_reuniao, 'reuniao.fim.hora_local_extenso': r?.horario_encerramento_reuniao_por_extenso,
    'reuniao.local': endereco?.descritivo ?? dados?.local,
    'reuniao.itens_pauta.descricoes_em_ordem': r?.itens_pauta.map(i => i.descricao) ?? [],
    'reuniao.participantes.nomes_presentes': pessoas.map(nome),
    'mesa.presidente_mesa.nome': mesa('PRESIDENTE'), 'mesa.secretario_mesa.nome': mesa('SECRETARIO'),
    'livro.numero': l?.numero, 'livro.titular': l?.titular, 'livro.serie': l?.serie,
    'livro.capacidade_folhas': l?.capacidade_folhas, 'livro.modalidade': l && { ELETRONICO: 'Eletrônico', PARA_ENCADERNACAO: 'Para encadernação', FISICO_DIGITALIZADO: 'Físico digitalizado' }[l.modalidade],
    'pessoa.redator_ata.nome': v.conteudo.redator_ata?.nome,
  };
  for (const k of camposEndereco) valoresFonte['reuniao.local.'+k] = endereco?.[k] || null;
  const definidas = Object.values(definicoes);
  const igreja = definidas.some(d => d.origem === 'igreja' || d.origem === 'contexto_por_extenso') ? await tx.igreja.findUniqueOrThrow({
    where: { id: igreja_id }, select: { nome: true, updated_at: true },
  }) : undefined;
  if (fontes.contexto && igreja) valoresFonte['contexto.nome.por_extenso'] = contextoPorExtenso(fontes.contexto.nome, igreja.nome);
  valoresFonte['igreja.nome'] = igreja?.nome;
  const autores = v.conteudo.autores_origem;
  const pessoasPorPapel: Record<string, string | null | undefined> = {
    nome_secretario_livro: fontes.secretarioLivro, redator_ata: v.conteudo.redator_ata?.pessoa_id, nome_convocante: autores.convocante, nome_preparador: autores.preparador,
  };
  const ids = definidas.map(d => pessoasPorPapel[d.origem]).filter((id): id is string => !!id);
  const decisoes = v.resolucoes ?? [];
  const posicionaDecisoes = definidas.some(d => d.origem === 'deliberacoes_reuniao');
  if (posicionaDecisoes) ids.push(...new Set(decisoes.flatMap(r => [...r.proponentes_pessoas_ids, ...r.dissidentes_pessoas_ids])));
  const registros = ids.length ? await tx.pessoas.findMany({
    where: { igreja_id, id: { in: ids } }, select: { id: true, nome_completo: true, updated_at: true },
  }) : [];
  const pessoasPorId = new Map(registros.map(p => [p.id, p]));
  if (posicionaDecisoes) valoresFonte['documento.resolucoes'] = textosDeliberacoes(decisoes, id => pessoasPorId.get(id)!.nome_completo);
  valoresFonte['pessoa.secretario_livro.nome'] = pessoasPorId.get(fontes.secretarioLivro ?? '')?.nome_completo;
  for (const papel of ['convocante','preparador'] as const)
    valoresFonte['pessoa.'+papel+'.nome'] = pessoasPorId.get(autores[papel] ?? '')?.nome_completo;
  if (fontes.atualizar && v.conteudo.redator_ata) {
    const redator = pessoasPorId.get(v.conteudo.redator_ata.pessoa_id);
    if (redator) valoresFonte['pessoa.redator_ata.nome'] = v.conteudo.redator_ata.nome = redator.nome_completo;
  }
  const semMapa = definidas.filter(d => !d.mapeamento && d.origem !== 'manual').map(d => d.origem);
  const legados = semMapa.length ? await tx.origem_campo_secretaria.findMany({ where: { chave: { in: semMapa } } }) : [];
  const saida: Record<string, unknown> = {};
  for (const [id,d] of Object.entries(definicoes)) {
    if (copiados[id]) { saida[id] = copiados[id]; continue; }
    if (d.origem === 'manual') {
      const valor = valores[id];
      if (!valor) continue;
      if (valor.tipo !== d.tipo || valor.multiplo !== d.multiplo || valor.origem.tipo !== 'manual') throw new BadRequestException('Valor incompatível com o campo ' + d.nome + '.');
      saida[id] = { ...valor, ajustado_manualmente: true };
      continue;
    }
    const mapa = d.mapeamento ?? legados.find(m => m.chave === d.origem);
    if (!mapa) throw new BadRequestException('Origem indisponível para o campo ' + d.nome + '.');
    const origem: Retrato = { cadastro: mapa.cadastro };
    if (['reuniao','mesa'].includes(mapa.cadastro) && r) Object.assign(origem, {registro_id: r.id, revisao: r.revisao});
    if (mapa.cadastro === 'livro' && l) Object.assign(origem, {registro_id: l.id, revisao: l.revisao});
    if (mapa.cadastro === 'contexto') origem.registro_id = fontes.contexto?.id;
    if (mapa.cadastro === 'igreja') Object.assign(origem, { registro_id: igreja_id, atualizado_em: igreja?.updated_at.toISOString() });
    if (mapa.cadastro === 'pessoa') {
      origem.registro_id = pessoasPorPapel[d.origem] ?? undefined;
      origem.atualizado_em = pessoasPorId.get(origem.registro_id ?? '')?.updated_at.toISOString();
    }
    const anteriorCampo = salvos?.[id];
    const mesmaFonte = anteriorCampo?.origem.tipo === 'sistema' && (anteriorCampo.origem.registro_id === origem.registro_id ||
      (!anteriorCampo.origem.cadastro && mapa.cadastro === 'igreja') ||
      (!anteriorCampo.origem.cadastro && ['reuniao','mesa'].includes(mapa.cadastro) && r?.id === anterior?.reuniao_id));
    const semValor = anteriorCampo?.valor == null || Array.isArray(anteriorCampo.valor) && !anteriorCampo.valor.length;
    const pendente = !fontes.previsto && semValor && (d.origem.startsWith('horario_') || mapa.cadastro === 'mesa' || d.origem === 'presentes');
    if (mesmaFonte && !fontes.atualizar && mapa.cadastro !== 'documento' && !pendente) { saida[id] = anteriorCampo; continue; }
    const chave = [mapa.cadastro, mapa.propriedade, mapa.transformacao].filter(Boolean).join('.');
    saida[id] = { tipo: d.tipo, multiplo: d.multiplo, valor: valoresFonte[chave] ?? (d.multiplo ? [] : null),
      origem: { tipo: 'sistema', chave: d.origem, ...(mapa.cadastro !== 'documento' && origem) }, ajustado_manualmente: false };
  }
  if (definidas.length) v.conteudo.valores = validar(valoresPaginaSchema, saida);
  if (fontes.planejamento) v.conteudo.planejamento_origem = fontes.atualizar || !salvo?.planejamento_origem ? fontes.planejamento : salvo.planejamento_origem;
  else delete v.conteudo.planejamento_origem;
  if (v.atualizar_fontes && v.atualizar_fontes !== assinaturaFontes(v)) throw new ConflictException('Os dados da origem mudaram. Confira as diferenças novamente.');
}
