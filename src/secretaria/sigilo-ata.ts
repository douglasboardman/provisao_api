import type { Prisma } from '@prisma/client';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { periodoOrgao } from '../orgaos/acesso-sociedades';
import { composicaoNaTransacao } from '../orgaos/composicao.service';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { cabeNaFaixa, configuracaoOrgao, dataCivilOrgao, regrasSociedade } from '../orgaos/sociedades-regras';

type Tx = Prisma.TransactionClient;
export type PermissaoAta = { ler: boolean; classificar: boolean };

function podeClassificar(cargo: { codigo: string; funcao: string; nome: string }, unidade = false) {
  if (['PRESIDENTE', 'SECRETARIO'].includes(cargo.funcao) ||
      ['PRESIDENTE', 'SECRETARIO', 'PRIMEIRO_SECRETARIO', 'SEGUNDO_SECRETARIO'].includes(cargo.codigo)) return true;
  // Ministérios cadastrados com cargos livres guardam o título no nome e o índice no código.
  if (!unidade || !/^MINISTERIO_\d+$/.test(cargo.codigo)) return false;
  const titulo = cargo.nome.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return ['presidente', 'presidenta', 'secretario', 'secretaria', 'primeiro secretario', 'primeira secretaria',
    'segundo secretario', 'segunda secretaria', 'secretario de atas', 'secretaria de atas'].includes(titulo);
}

async function integraOrgaoOficial(tx: Tx, igrejaId: string, orgaoId: string, tipo: 'CONSELHO' | 'JUNTA', dia: string, pessoaId: string) {
  const composicao = await composicaoNaTransacao(tx, igrejaId, tipo, dia, [pessoaId], orgaoId);
  const membro = composicao.membros.find(m => m.pessoa_id === pessoaId);
  if (!membro || membro.revisao_pendente || composicao.situacao_indeterminada.includes(pessoaId)) return false;
  return !!await tx.oficial.findFirst({ where: { igreja_id: igrejaId, pessoa_id: pessoaId, tipo: { in: membro.oficios }, ativo: true },
    select: { id: true } });
}

/** Decide a leitura do teor e a classificação de atas restritas pelo exercício institucional atual. */
export async function permissoesAtas(tx: Tx, igrejaId: string, pessoaId: string | null | undefined): Promise<Map<string, PermissaoAta>> {
  const permissoes = new Map<string, PermissaoAta>();
  if (!pessoaId) return permissoes;

  const dia = await hojeDaIgreja(tx, igrejaId);
  const data = dataCivilOrgao(dia);
  const orgaos = await tx.orgao_interno.findMany({ where: { igreja_id: igrejaId,
    OR: [{ tipo: 'CONSELHO', ativo: true }, { contexto_secretaria: { isNot: null } }] },
    select: { id: true, tipo: true, ativo: true, contexto_secretaria: { select: { id: true } } } });

  for (const orgao of orgaos) {
    if (orgao.ativo && orgao.tipo === 'CONSELHO' && await integraOrgaoOficial(tx, igrejaId, orgao.id, 'CONSELHO', dia, pessoaId)) {
      for (const { contexto_secretaria } of orgaos) {
        if (contexto_secretaria) permissoes.set(contexto_secretaria.id, { ler: true, classificar: true });
      }
      return permissoes;
    }
  }

  const periodo = periodoOrgao(data);
  const ocupacoes = await tx.ocupacao_cargo.findMany({
    where: { igreja_id: igrejaId, pessoa_id: pessoaId, ...periodo, AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }],
      cargo: { ativo: true, orgao: { ativo: true, tipo: { in: ['JUNTA', 'SOCIEDADE_INTERNA', 'UNIDADE_MINISTERIAL'] } } } },
    select: { orgao_id: true, cargo: { select: { codigo: true, funcao: true, nome: true } } },
  });
  for (const orgao of orgaos) {
    if (orgao.tipo !== 'JUNTA' || !orgao.ativo || !orgao.contexto_secretaria) continue;
    if (await integraOrgaoOficial(tx, igrejaId, orgao.id, 'JUNTA', dia, pessoaId)) {
      permissoes.set(orgao.contexto_secretaria.id, { ler: true,
        classificar: ocupacoes.some(o => o.orgao_id === orgao.id && podeClassificar(o.cargo)) });
    }
  }

  const diretorias = orgaos.filter(o => o.ativo && o.contexto_secretaria &&
    (o.tipo === 'SOCIEDADE_INTERNA' || o.tipo === 'UNIDADE_MINISTERIAL') &&
    ocupacoes.some(ocupacao => ocupacao.orgao_id === o.id));
  if (!diretorias.length) return permissoes;
  const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: pessoaId, data_evento: { lte: data } },
    select: { data_evento: true, ordem_dia: true, rol: true } });
  const rol = eventoVigente(eventos, data);
  if (rol.situacao !== 'DEFINIDO' || !['COMUNGANTES', 'NAO_COMUNGANTES'].includes(rol.evento.rol)) return permissoes;

  for (const orgao of diretorias) {
    let cargos = ocupacoes.filter(o => o.orgao_id === orgao.id);
    if (orgao.tipo === 'SOCIEDADE_INTERNA') {
      cargos = cargos.filter(o => !['CONSELHEIRO', 'ORIENTADOR'].includes(o.cargo.codigo));
      if (!cargos.length) continue;
      const socio = await tx.membro_orgao.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgao.id, pessoa_id: pessoaId,
        categoria_participacao: 'LOCAL', ...periodo }, select: { pessoa: { select: { data_nascimento: true } } } });
      const versao = await tx.versao_orgao.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgao.id, ...periodo }, select: { configuracao: true } });
      const regra = regrasSociedade.safeParse(configuracaoOrgao(versao?.configuracao).regra_sociedade);
      if (!socio || !regra.success || !cabeNaFaixa(regra.data, socio.pessoa.data_nascimento, dia)) continue;
    } else if (rol.evento.rol !== 'COMUNGANTES') continue;
    permissoes.set(orgao.contexto_secretaria!.id, { ler: true, classificar: cargos.some(o => podeClassificar(o.cargo, orgao.tipo === 'UNIDADE_MINISTERIAL')) });
  }
  return permissoes;
}

export async function permissoesAtasDaConta(tx: Tx, igrejaId: string, usuarioId: string): Promise<Map<string, PermissaoAta>> {
  const conta = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true }, select: { pessoa_id: true } });
  return permissoesAtas(tx, igrejaId, conta?.pessoa_id);
}
