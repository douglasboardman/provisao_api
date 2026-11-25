import { identificacaoDocumento } from './numeracao-ata-livro';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { valoresPaginaSchema, type ValoresPagina } from './composicao-pagina';
import { configuracaoSchema, validar, type ConfiguracaoModelo, type VersaoInput } from './secretaria.dto';
import type { AtorSecretaria, SecretariaBaseService, Tx } from './secretaria-base.service';

type Regra = NonNullable<ConfiguracaoModelo['antecedentes']>[number];
function compativel(regra: Regra, destino: ConfiguracaoModelo, origem: Pick<ConfiguracaoModelo, 'definicoes'>) {
  return Object.entries(regra.campos).every(([id, fonte]) => {
    const d = destino.definicoes?.[id], o = origem.definicoes?.[fonte];
    return d?.origem === 'manual' && !!o && o.tipo === d.tipo && o.multiplo === d.multiplo;
  });
}

export async function validarEncadeamento(tx: Tx, igreja_id: string, contexto_id: string, modelo: string, config: ConfiguracaoModelo) {
  const regras = config.antecedentes ?? [];
  if (!regras.length) return;
  const ids = regras.map(r => r.modelo_id);
  if (config.motivador === 'NAO_PERMITE' || new Set(ids).size !== ids.length) throw new BadRequestException('Confira os modelos antecedentes e a política de vínculo.');
  const modelos = await tx.modelo_documento.findMany({ where: { igreja_id, contexto_id, id: { in: ids } },
    select: { id: true, versoes: { take: 1, orderBy: { numero: 'desc' }, select: { configuracao: true } } } });
  for (const regra of regras) {
    const versao = modelos.find(m => m.id === regra.modelo_id)?.versoes[0];
    if (!versao || !compativel(regra, config, validar(configuracaoSchema, versao.configuracao))) {
      throw new BadRequestException('Modelo antecedente indisponível ou campos incompatíveis. Confira os tipos e a multiplicidade.');
    }
  }
  // Versões históricas também podem originar documentos. UNION visita cada modelo uma vez.
  const ciclo = await tx.$queryRaw<{ existe: boolean }[]>`
    WITH RECURSIVE caminho(id) AS (
      SELECT unnest(${ids}::text[])
      UNION
      SELECT regra->>'modelo_id' FROM caminho c
        JOIN modelo_documento_versao v ON v.modelo_id=c.id AND v.igreja_id=${igreja_id} AND v.contexto_id=${contexto_id}
        CROSS JOIN LATERAL jsonb_array_elements(v.configuracao->'antecedentes') regra
    ) SELECT EXISTS(SELECT 1 FROM caminho WHERE id=${modelo}) AS existe`;
  if (ciclo[0].existe) throw new BadRequestException('O encadeamento criaria um ciclo entre modelos.');
}

// A busca e a escolha final consideram os tipos guardados em cada versão publicada.
export async function versoesElegiveis(tx: Tx, igreja_id: string, contexto_id: string, config: ConfiguracaoModelo) {
  const regras = config.antecedentes ?? [];
  if (!regras.length) return [];
  const porModelo = new Map(regras.map(r => [r.modelo_id,r]));
  const candidatas = await tx.$queryRaw<{ id: string; modelo_id: string; definicoes: ConfiguracaoModelo['definicoes'] }[]>`
    SELECT id, modelo_id, configuracao->'definicoes' AS definicoes
    FROM modelo_documento_versao WHERE igreja_id=${igreja_id} AND contexto_id=${contexto_id}
      AND modelo_id = ANY(${[...porModelo.keys()]}::text[])`;
  return candidatas.filter(v => compativel(porModelo.get(v.modelo_id)!, config, v)).map(v => v.id);
}

export async function copiarOrigem(tx: Tx, base: SecretariaBaseService, a: AtorSecretaria, contexto: string, restrito: boolean,
  config: ConfiguracaoModelo, origemId: string, historica: boolean, reuniaoAta?: string) {
  const fonte = await tx.documento_versao.findFirst({ where: { id: origemId, igreja_id: a.igreja_id, contexto_id: contexto },
    select: { id: true, numero: true, assunto: true, data_documento: true, numero_original: true, conteudo: true, reuniao_id: true, modelo: { select: { modelo_id: true, finalidade: true, configuracao: true } },
      documento: { select: { restrito: true, estado: true, versao_atual: true, numero: true, identificacao_livro: true, sigla: true, ano: true } } } });
  const regra = config.antecedentes?.find(r => r.modelo_id === fonte?.modelo?.modelo_id);
  if (!fonte?.modelo || !regra || (reuniaoAta && (fonte.reuniao_id !== reuniaoAta || fonte.modelo.finalidade !== 'CONVOCACAO')) || (fonte.documento.restrito && !restrito) ||
    (!historica && (fonte.documento.estado !== 'EXPEDIDO' || fonte.numero !== fonte.documento.versao_atual))) {
    throw new BadRequestException('Documento anterior indisponível para este modelo e contexto.');
  }
  if (fonte.documento.restrito) await base.competente(tx, a, contexto, 'pode_consultar_restritos');
  if (!compativel(regra, config, validar(configuracaoSchema, fonte.modelo.configuracao))) throw new BadRequestException('Campos incompatíveis com a versão do documento anterior.');
  const valores = validar(valoresPaginaSchema, (fonte.conteudo as VersaoInput['conteudo']).valores ?? {});
  const copiados = validar(valoresPaginaSchema, Object.fromEntries(Object.entries(regra.campos).map(([id, campo_id]) => {
    const d = config.definicoes![id];
    return [id, { tipo: d.tipo, multiplo: d.multiplo, valor: valores[campo_id]?.valor ?? (d.multiplo ? [] : null),
      origem: { tipo: 'documento_anterior', versao_id: fonte.id, campo_id }, ajustado_manualmente: false }];
  })));
  const d = fonte.documento;
  const numero = fonte.numero_original ?? identificacaoDocumento(d);
  const data = fonte.data_documento.toISOString().slice(0,10).split('-').reverse().join('/');
  return { valores: copiados, antecedente: { versao_id: fonte.id, identificacao: [numero, data, fonte.assunto, 'v'+fonte.numero].join(' · ') } };
}

export async function resolverOrigem(tx: Tx, base: SecretariaBaseService, a: AtorSecretaria, contexto: string, restrito: boolean,
  config: ConfiguracaoModelo, v: VersaoInput, atualId?: string, reuniaoAta?: string, novoDocumento = false) {
  const anterior = atualId ? await tx.documento_versao.findFirst({ where: { id: atualId, igreja_id: a.igreja_id, contexto_id: contexto },
    select: { modelo_versao_id: true, motivador_id: true, reuniao_id: true, conteudo: true } }) : null;
  const salvos = (anterior?.conteudo as VersaoInput['conteudo'] | undefined)?.valores ?? {};
  const mesma = anterior?.motivador_id === v.motivador_id && anterior?.modelo_versao_id === v.modelo_versao_id;
  const encadeado = !!config.antecedentes?.length;
  if (encadeado && config.motivador === 'OBRIGATORIO' && !v.motivador_id) throw new BadRequestException('Selecione o documento anterior exigido pelo modelo.');
  const historica = mesma && !novoDocumento && anterior?.reuniao_id === v.reuniao_id;
  const previa = encadeado && v.motivador_id ? await copiarOrigem(tx, base, a, contexto, restrito, config, v.motivador_id, historica, historica ? undefined : reuniaoAta) : null;
  if (previa) v.conteudo.antecedente = previa.antecedente;
  else delete v.conteudo.antecedente;
  const copiados: ValoresPagina = previa?.valores ?? {};
  if (anterior && !mesma && !v.confirmar_troca_origem && Object.entries(salvos).some(([id, c]) => c.ajustado_manualmente && (copiados[id] || c.origem.tipo === 'documento_anterior'))) {
    throw new ConflictException('Confirme a troca da origem para substituir campos ajustados manualmente.');
  }
  for (const [id, copia] of Object.entries(copiados)) {
    const recebido = v.conteudo.valores?.[id], origem = recebido?.origem;
    if (origem && (origem.tipo !== 'documento_anterior' || copia.origem.tipo !== 'documento_anterior' ||
        origem.versao_id !== copia.origem.versao_id || origem.campo_id !== copia.origem.campo_id)) throw new BadRequestException('A origem informada para o campo não corresponde ao documento selecionado.');
    if (recebido && (recebido.tipo !== copia.tipo || recebido.multiplo !== copia.multiplo)) throw new BadRequestException('Tipo de campo incompatível com a origem.');
    if (recebido?.ajustado_manualmente) copiados[id] = { ...recebido, origem: copia.origem };
    else if (mesma && salvos[id]) copiados[id] = salvos[id];
  }
  return copiados;
}
