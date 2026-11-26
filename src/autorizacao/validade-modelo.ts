import type { oficio_tipo } from '@prisma/client';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { composicaoNaTransacao } from '../orgaos/composicao.service';
import { dataCivilNoFuso } from '../orgaos/relogio-igreja';
import type { Conta, Tx } from './politica';

export type RequisitoModelo = { cargo_id: string | null; oficio: oficio_tipo | null };

export async function calendarioPerfis(tx: Tx, igreja: string, instante: Date) {
  const config = await tx.configuracao_fuso_igreja.findUnique({ where: { igreja_id: igreja }, select: { fuso_iana: true } });
  const fuso = config?.fuso_iana ?? 'UTC';
  return { dia: dataCivilNoFuso(instante, fuso), fuso };
}

const dataSeguinte = (data: Date) => new Date(data.getTime() + 86_400_000);

async function qualificarRequisito(tx: Tx, requisito: RequisitoModelo, igreja_id: string, pessoa_id: string, dia: string) {
  const data = new Date(dia + 'T00:00:00Z');
  if (requisito.cargo_id) {
    const ocupacoes = await tx.ocupacao_cargo.findMany({ where: { igreja_id, pessoa_id, cargo_id: requisito.cargo_id,
      inicio: { lte: data }, AND: [{ OR: [{ fim: null }, { fim: { gt: data } }] }, {
        OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }],
      }], cargo: { ativo: true, orgao: { ativo: true, tipo: { in: ['CONSELHO', 'JUNTA'] } } },
    }, include: { cargo: { include: { orgao: { select: { tipo: true } } } } }, take: 2 });
    if (ocupacoes.length !== 1) return null;
    const [ocupacao] = ocupacoes;
    const tipo = ocupacao.cargo.orgao.tipo;
    if (tipo !== 'CONSELHO' && tipo !== 'JUNTA') return null;
    const composicao = await composicaoNaTransacao(tx, igreja_id, tipo, dia, [pessoa_id], ocupacao.orgao_id);
    if (composicao.situacao_indeterminada.includes(pessoa_id)) return null;
    const membro = composicao.membros.find(m => m.pessoa_id === pessoa_id);
    if (membro?.revisao_pendente) return null;
    if (!membro) {
      if (tipo !== 'CONSELHO' || (ocupacao.cargo.funcao !== 'TESOUREIRO' && ocupacao.cargo.codigo !== 'TESOUREIRO')) return null;
      const historico = await tx.eventos_membresia.findMany({ where: { igreja_id, pessoa_id, data_evento: { lte: data } },
        select: { data_evento: true, ordem_dia: true, rol: true } });
      const atual = eventoVigente(historico, data);
      if (atual.situacao !== 'DEFINIDO' || atual.evento.rol !== 'COMUNGANTES') return null;
    }
    const limites = [ocupacao.fim, ocupacao.termino_previsto && dataSeguinte(ocupacao.termino_previsto)]
      .filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime());
    return { id: ocupacao.id, fimCivil: limites[0]?.toISOString().slice(0, 10) ?? null };
  }

  const tipo = requisito.oficio;
  if (!tipo) return null;
  const composicao = await composicaoNaTransacao(tx, igreja_id, tipo === 'DIACONO' ? 'JUNTA' : 'CONSELHO', dia, [pessoa_id]);
  if (!composicao.membros.some(m => m.pessoa_id === pessoa_id && m.oficios.includes(tipo) && !m.revisao_pendente)) return null;
  const oficial = { pessoa_id, tipo };
  if (tipo === 'PRESBITERO_DOCENTE') {
    const vinculo = await tx.vinculo_pastoral.findFirst({ where: { igreja_id, oficial, exercicio_institucional: true,
      data_inicio: { lte: data }, OR: [{ data_fim: null }, { data_fim: { gte: data } }] } });
    return vinculo ? { id: vinculo.id, fimCivil: vinculo.data_fim ? dataSeguinte(vinculo.data_fim).toISOString().slice(0, 10) : null } : null;
  }
  const mandato = await tx.mandato_oficial.findFirst({ where: { igreja_id, oficial, data_posse: { lte: data },
    OR: [{ termino_efetivo: { gte: data } }, { termino_efetivo: null, termino_previsto: { gte: data } }] } });
  return mandato ? { id: mandato.id, fimCivil: dataSeguinte(mandato.termino_efetivo ?? mandato.termino_previsto).toISOString().slice(0, 10) } : null;
}

export async function qualificarPerfil<R extends RequisitoModelo>(
  tx: Tx, requisitos: R[], igrejaId: string, pessoaId: string, dia: string, qualificacaoId?: string,
) {
  for (const requisito of requisitos) {
    const origem = await qualificarRequisito(tx, requisito, igrejaId, pessoaId, dia);
    if (origem && (!qualificacaoId || origem.id === qualificacaoId)) return { ...origem, requisito };
  }
  return null;
}

export async function filtrarAtribuicoesDeModelos<R extends { concessao_modelo_id: string | null }>(
  tx: Tx, conta: Conta, registros: R[], agora: Date,
): Promise<R[]> {
  const ids = [...new Set(registros.flatMap(r => r.concessao_modelo_id ? [r.concessao_modelo_id] : []))];
  if (!ids.length) return registros;
  if (!conta.conta_atuacao || !conta.pessoa_id) return registros.filter(r => !r.concessao_modelo_id);
  const [concessoes, { dia }] = await Promise.all([
    tx.concessao_modelo_atuacao.findMany({ where: { id: { in: ids }, igreja_id: conta.igreja_id, usuario_id: conta.id,
      pessoa_id: conta.pessoa_id, geracao_vinculo: conta.geracao_vinculo, revogado_em: null,
      inicio: { lte: agora }, OR: [{ fim: null }, { fim: { gt: agora } }] },
      include: { modelo: { include: { requisitos_adicionais: { orderBy: { ordem: 'asc' } } } } } }),
    calendarioPerfis(tx, conta.igreja_id, agora),
  ]);
  const validas = await Promise.all(concessoes.map(async c => {
    const origem = await qualificarPerfil(tx, [c.modelo, ...c.modelo.requisitos_adicionais], c.igreja_id, c.pessoa_id, dia, c.qualificacao_id);
    return origem ? c.id : null;
  }));
  return registros.filter(r => !r.concessao_modelo_id || validas.includes(r.concessao_modelo_id));
}
