import { BadRequestException } from '@nestjs/common';
import type { Tx } from './secretaria-base.service';
import type { ConfiguracaoModelo, VersaoInput } from './secretaria.dto';

export const ehPapelMesa = (papel: string) => papel === 'PRESIDENTE' || papel === 'SECRETARIO';
export const incluirOficialMesa = { oficial: { select: { pessoa_id: true } } } as const;
type Titulares = { oficial: { pessoa_id: string }; secretario_id: string; secretario_nome: string };

type Sessao = { id: string; igreja_id: string; contexto_id: string };
export const escopoMesa = (r: Sessao) => ({ reuniao_id: r.id, igreja_id: r.igreja_id, contexto_id: r.contexto_id });

export function mesaVigente(tx: Tx, reuniao: Sessao, instante = new Date()) {
  return tx.mesa_assembleia.findFirst({
    where: { ...escopoMesa(reuniao), vigente_desde: { lte: instante } },
    orderBy: { ordem: 'desc' }, include: incluirOficialMesa,
  });
}

export function conferirVotacao(mesa: { votantes_confirmados: unknown } | null, participantes: { pessoa_id: string; presente: boolean }[], minimo: number, conferir: boolean) {
  const direito = Array.isArray(mesa?.votantes_confirmados) ? new Set<string>(mesa.votantes_confirmados) : null;
  const presentes = [...new Set(participantes.filter(p => p.presente).map(p => p.pessoa_id))];
  const votantes = direito ? presentes.filter(id => direito.has(id)) : presentes;
  if (conferir && votantes.length < minimo)
    throw new BadRequestException(direito ? 'Votantes presentes insuficientes para o quórum declarado.' : 'Presença insuficiente para o quórum declarado.');
  return { base: direito ? 'VOTANTES_CONFIRMADOS' as const : 'PRESENCAS_LEGADAS' as const, presentes: presentes.length,
    votantes_presentes: direito ? votantes : null, minimo };
}

export function conferirApuracoes(mesa: { votantes_confirmados: unknown } | null, participantes: { pessoa_id: string; presente: boolean }[],
  resolucoes: VersaoInput['resolucoes']) {
  if (!resolucoes?.length) return;
  const votantes = conferirVotacao(mesa, participantes, 0, false).votantes_presentes;
  if (!votantes) return;
  for (const resolucao of resolucoes) {
    const a = resolucao.apuracao;
    if (a && Math.max(a.quorum ?? 0, (a.favoraveis ?? 0) + (a.contrarios ?? 0) + (a.abstencoes ?? 0) + (a.impedimentos ?? 0)) > votantes.length)
      throw new BadRequestException(`Resolução ${resolucao.ordem}: a apuração excede os votantes presentes confirmados.`);
  }
}

export function aplicarMesa(conteudo: VersaoInput['conteudo'], mesa: Titulares, config: ConfiguracaoModelo) {
  const titulares = new Map([[mesa.oficial.pessoa_id, 'PRESIDENTE'], [mesa.secretario_id, 'SECRETARIO']]);
  const fundamento = 'Titular da mesa instalada da assembleia.';
  conteudo.redator_ata = { pessoa_id: mesa.secretario_id, nome: mesa.secretario_nome };
  for (const p of conteudo.arrolados) {
    const papel = titulares.get(p.pessoa_id);
    if (!papel && !p.papeis.some(ehPapelMesa)) continue;
    p.papeis = p.papeis.filter(r => !ehPapelMesa(r));
    if (papel) {
      p.papeis.push(papel);
      p.assina = p.obrigatorio = true;
      if (!p.fundamento) p.fundamento = fundamento;
      if (papel === 'SECRETARIO' || p.fundamento === fundamento) p.responsavel = papel === 'SECRETARIO';
      titulares.delete(p.pessoa_id);
    } else {
      if (!p.papeis.length) p.papeis.push('PARTICIPANTE');
      if (p.fundamento === fundamento) {
        p.responsavel = false;
        if (config.assinaturas_reuniao !== 'PRESENTES' && !p.cargo_id && !p.cargos_ids.length && !p.papeis.some(r => config.papeis_obrigatorios.includes(r)))
          p.assina = p.obrigatorio = false;
      }
    }
  }
  for (const [pessoa_id, papel] of titulares) {
    conteudo.arrolados.push({ pessoa_id, papeis: [papel], cargo_id: null, cargos_ids: [], assina: true,
      obrigatorio: true, responsavel: papel === 'SECRETARIO', fundamento });
  }
}
