import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Tx } from './secretaria-base.service';
import type { ConfiguracaoModelo, ReuniaoInput, VersaoInput } from './secretaria.dto';
import { resultadosResolucao, type ResolucaoInput } from './resolucoes.dto';

const pessoaSelect = { pessoa_id: true, retrato: true, papeis: true } satisfies Prisma.arrolado_documentoSelect;
export const incluirResolucao = {
  proponentes: { select: { arrolado: { select: pessoaSelect } } },
  dissidentes: { select: { arrolado: { select: pessoaSelect } } },
} satisfies Prisma.resolucaoInclude;
export const incluirResolucoes = {
  orderBy: { ordem: 'asc' },
  include: incluirResolucao,
} satisfies Prisma.documento_versao$resolucoesArgs;
type Resolucao = Prisma.resolucaoGetPayload<{ include: typeof incluirResolucao }>;

export function entradaResolucoes(resolucoes: Resolucao[]): ResolucaoInput[] {
  return resolucoes.map((r) => ({
    item_pauta_id: r.item_pauta_id,
    ordem: r.ordem,
    assunto: r.assunto,
    texto_proposta: r.texto_proposta,
    texto_deliberado: r.texto_deliberado,
    resultado: r.resultado,
    eficaz: r.eficaz,
    data_efeito: r.data_efeito?.toISOString().slice(0, 10) ?? null,
    votacao_secreta: r.votacao_secreta,
    apuracao: r.apuracao as ResolucaoInput['apuracao'],
    proponentes_pessoas_ids: r.proponentes.map((p) => p.arrolado.pessoa_id),
    dissidentes_pessoas_ids: r.dissidentes.map((p) => p.arrolado.pessoa_id),
  }));
}

export function validarResolucoes(versao: VersaoInput, config: ConfiguracaoModelo, reuniao?: ReuniaoInput, pauta: { id: string }[] = []) {
  const resolucoes = versao.resolucoes ?? [];
  if (resolucoes.length && config.resolucoes === 'NAO_PERMITE')
    throw new BadRequestException('Modelo não permite resoluções.');

  const arrolados = new Map(versao.conteudo.arrolados.map((p) => [p.pessoa_id, p]));
  const participantes = new Map(reuniao?.participantes.map((p) => [p.pessoa_id, p]));
  const podePropor = (id: string) => {
    const fundamento = arrolados.get(id)?.fundamento;
    if (!reuniao) return !!fundamento;
    const participante = participantes.get(id);
    // Reuniões anteriores à E08 podem estar fechadas para edição.
    return participante?.presente && (participante.pode_propor ?? !!fundamento);
  };
  for (const r of resolucoes) {
    if (r.item_pauta_id && !pauta.some(i => i.id === r.item_pauta_id))
      throw new BadRequestException('O item selecionado não pertence à pauta desta reunião.');
    if ([...r.proponentes_pessoas_ids, ...r.dissidentes_pessoas_ids].some((id) => !arrolados.has(id))) {
      throw new BadRequestException(
        `Resolução ${r.ordem}: proponentes e dissidentes devem estar arrolados nesta versão.`,
      );
    }
    if (r.proponentes_pessoas_ids.some((id) => !podePropor(id))) {
      throw new BadRequestException(
        `Resolução ${r.ordem}: confirme a competência de cada proponente ${reuniao ? 'na reunião ou no fundamento do arrolamento histórico' : 'no fundamento do seu arrolamento'}.`,
      );
    }
  }
}

export async function salvarResolucoes(
  tx: Tx,
  escopo: { igreja_id: string; contexto_id: string; versao_id: string },
  resolucoes: ResolucaoInput[] = [],
) {
  if (!resolucoes.length) return;
  const arrolados = await tx.arrolado_documento.findMany({ where: escopo, select: { id: true, pessoa_id: true } });
  const porPessoa = new Map(arrolados.map((p) => [p.pessoa_id, p.id]));
  const vinculos = (ids: string[]) =>
    ids.map((pessoa) => {
      const arrolado_id = porPessoa.get(pessoa);
      if (!arrolado_id) throw new BadRequestException('Pessoa não arrolada nesta versão.');
      return { arrolado_id, ...escopo };
    });
  for (const r of resolucoes) {
    const { proponentes_pessoas_ids, dissidentes_pessoas_ids, data_efeito, apuracao, ...dados } = r;
    const { id } = await tx.resolucao.create({
      data: {
        ...dados,
        ...escopo,
        data_efeito: data_efeito ? new Date(data_efeito) : null,
        apuracao: apuracao ?? undefined,
      },
      select: { id: true },
    });
    if (proponentes_pessoas_ids.length) {
      await tx.resolucao_proponente.createMany({
        data: vinculos(proponentes_pessoas_ids).map((p) => ({ ...p, resolucao_id: id })),
      });
    }
    if (dissidentes_pessoas_ids.length) {
      await tx.resolucao_dissidente.createMany({
        data: vinculos(dissidentes_pessoas_ids).map((p) => ({ ...p, resolucao_id: id })),
      });
    }
  }
}

type Retrato = { nome: string; cargo?: { nome: string } | null; cargos?: { nome: string }[] };
export function nomeComCargos(retrato: unknown) {
  const p = retrato as Retrato;
  const cargos = p.cargos?.length ? p.cargos : p.cargo ? [p.cargo] : [];
  return cargos.length ? `${p.nome} (${cargos.map((c) => c.nome).join(', ')})` : p.nome;
}

export function resolucoesParaMatriz(resolucoes: Resolucao[], retratos: { pessoa_id: string; retrato: unknown }[]) {
  const porPessoa = new Map(retratos.map((p) => [p.pessoa_id, p.retrato]));
  const nomes = (pessoas: Resolucao['proponentes']) =>
    pessoas
      .map(({ arrolado }) => nomeComCargos(porPessoa.get(arrolado.pessoa_id) ?? arrolado.retrato))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return resolucoes.map((r) => ({
    ordem: r.ordem,
    assunto: r.assunto,
    proposta: r.texto_proposta,
    deliberado: r.texto_deliberado,
    resultado: resultadosResolucao[r.resultado],
    eficaz: r.eficaz,
    dataEfeito: r.data_efeito?.toISOString().slice(0, 10),
    secreta: r.votacao_secreta,
    apuracao: r.apuracao as ResolucaoInput['apuracao'],
    proponentes: nomes(r.proponentes),
    dissidentes: nomes(r.dissidentes),
  }));
}
