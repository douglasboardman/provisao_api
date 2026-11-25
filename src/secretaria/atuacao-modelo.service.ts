import { cabeNaFaixa, configuracaoOrgao, regrasSociedade } from '../orgaos/sociedades-regras';
import { periodoOrgao } from '../orgaos/acesso-sociedades';
import { mesaVigente } from './mesa-assembleia';
import { agruparPorPessoa } from '../pessoas/agrupar-por-pessoa';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { ComposicaoService } from '../orgaos/composicao.service';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { cargosDoArrolado, configuracaoSchema, type ConfiguracaoModelo, type VersaoInput } from './secretaria.dto';

type Tx = Prisma.TransactionClient;
type Contexto = { id: string; igreja_id: string; tipo: string; orgao_id: string | null; orgao: { tipo: string; ativo: boolean; gestao_presidencial?: boolean } | null };
type Regra = ConfiguracaoModelo['atuacao'];
export type AcaoModelo = 'criar' | 'preparar' | 'editar';
const mesa = [{ id: 'PRESIDENTE_MESA', nome: 'Presidente da assembleia' }, { id: 'SECRETARIO_MESA', nome: 'Secretário de atas da assembleia' }];

export async function opcoesAtuacao(tx: Tx, c: Contexto) {
  if (c.orgao && !c.orgao.ativo) return [];
  const assembleia = c.tipo === 'ASSEMBLEIA_GERAL';
  const cargos = await tx.cargo_orgao.findMany({
    where: { igreja_id: c.igreja_id, ativo: true, ...(assembleia ? { orgao: { tipo: 'CONSELHO', ativo: true } } : { orgao_id: c.orgao_id! }) },
    select: { id: true, nome: true, codigo: true }, orderBy: { nome: 'asc' },
  });
  return [
    ...(assembleia || c.orgao?.tipo === 'CONSELHO' ? [{ id: 'PRESIDENCIA_CONSELHO', nome: 'Presidente institucional do Conselho', codigo: 'PRESIDENCIA_CONSELHO' }] : []),
    ...cargos.map(cargo => ({ ...cargo, nome: assembleia ? cargo.nome + ' do Conselho' : cargo.nome })),
    ...(assembleia ? mesa.map(p => ({ ...p, codigo: p.id })) : []),
  ];
}

export function validarAtuacao(regra: Regra, opcoes: { id: string; codigo: string }[], publicar: boolean) {
  if (publicar && !regra?.criar.length) throw new BadRequestException('Selecione quem pode criar este documento antes de publicar o modelo.');
  if (regra && [...regra.criar, ...regra.preparar, ...regra.assinar].some(id => !opcoes.some(p => p.id === id)))
    throw new BadRequestException('Selecione apenas cargos ativos disponíveis neste contexto.');
  const substituicao = regra?.substituicao_assinatura;
  if (regra && substituicao) {
    const titular = opcoes.find(p => p.id === substituicao.titular);
    const substituto = opcoes.find(p => p.id === substituicao.substituto);
    if (!titular || !['PRIMEIRO_SECRETARIO', 'SECRETARIO'].includes(titular.codigo) || substituto?.codigo !== 'SEGUNDO_SECRETARIO' ||
        !regra.assinar.includes(titular.id) || regra.assinar.includes(substituto.id))
      throw new BadRequestException('Para aceitar a substituição, indique o primeiro secretário como signatário e o segundo como substituto.');
  }
}

export function permissoesModelo(regra: Regra, papeis: Set<string>) {
  return { criar: !!regra?.criar.some(id => papeis.has(id)), preparar: !!regra?.preparar.some(id => papeis.has(id)) };
}

@Injectable()
export class AtuacaoModeloService {
  constructor(private readonly composicao: ComposicaoService) {}

  composicaoDoOrgao(tx: Tx, c: Contexto, dia: string) {
    return this.composicao.consultarNaTransacao(tx, c.igreja_id, c.orgao?.tipo === 'JUNTA' ? 'JUNTA' : 'CONSELHO', dia, undefined, c.orgao_id ?? undefined);
  }

  async papeis(tx: Tx, c: Contexto, pessoa: string | null, dia?: string) {
    if (!pessoa) return new Set<string>();
    return (await this.papeisPorPessoa(tx, c, [pessoa], dia)).get(pessoa)!;
  }

  async papeisPorPessoa(tx: Tx, c: Contexto, pessoas: string[], dia?: string) {
    const porPessoa = new Map(pessoas.map(id => [id, new Set<string>()]));
    if (!porPessoa.size || c.orgao?.ativo === false) return porPessoa;
    const referencia = dia ?? await hojeDaIgreja(tx, c.igreja_id);
    const data = new Date(referencia + 'T00:00:00Z');
    const assembleia = c.tipo === 'ASSEMBLEIA_GERAL';
    const conselho = assembleia || c.orgao?.tipo === 'CONSELHO';
    const vigencia = { inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] };
    const ocupacoes = await tx.ocupacao_cargo.findMany({ where: {
      igreja_id: c.igreja_id, pessoa_id: { in: [...porPessoa.keys()] }, ...vigencia,
      cargo: { ativo: true, ...(assembleia ? { orgao: { tipo: 'CONSELHO', ativo: true } } : { orgao_id: c.orgao_id! }) },
      AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }],
    }, select: { pessoa_id: true, cargo_id: true, cargo: { select: { funcao: true, codigo: true } } } });
    const presidencias = conselho ? await tx.presidencia_conselho.findMany({ where: { igreja_id: c.igreja_id, ...vigencia }, select: { oficial: { select: { pessoa_id: true } } }, take: 2 }) : [];
    const presidente = presidencias.length === 1 ? presidencias[0].oficial.pessoa_id : null;
    const candidatos = new Set(ocupacoes.map(o => o.pessoa_id));
    if (presidente && porPessoa.has(presidente)) candidatos.add(presidente);
    if (!candidatos.size) return porPessoa;

    const cargos = agruparPorPessoa(ocupacoes);
    if (conselho || c.orgao?.tipo === 'JUNTA') {
      const composicao = await this.composicao.consultarNaTransacao(tx, c.igreja_id, conselho ? 'CONSELHO' : 'JUNTA', referencia, [...candidatos], assembleia ? undefined : c.orgao_id ?? undefined);
      const membros = new Map(composicao.membros.map(m => [m.pessoa_id, m]));
      const indeterminados = new Set(composicao.situacao_indeterminada);
      for (const id of candidatos) {
        const membro = membros.get(id);
        if (!membro && conselho && !indeterminados.has(id)) continue;
        candidatos.delete(id);
        if (!membro || membro.revisao_pendente || indeterminados.has(id)) continue;
        const papeis = porPessoa.get(id)!;
        if (id === presidente && membro.oficios.includes('PRESBITERO_DOCENTE')) papeis.add('PRESIDENCIA_CONSELHO');
        for (const o of cargos.get(id) ?? []) papeis.add(o.cargo_id);
      }
    }
    if (!candidatos.size) return porPessoa;
    const sociedade = c.orgao?.tipo === 'SOCIEDADE_INTERNA';
    const [membros, versao] = sociedade ? await Promise.all([
      tx.membro_orgao.findMany({ where: { igreja_id: c.igreja_id, orgao_id: c.orgao_id!, pessoa_id: { in: [...candidatos] },
        categoria_participacao: 'LOCAL', ...periodoOrgao(data) }, select: { pessoa_id: true, pessoa: { select: { data_nascimento: true } } } }),
      tx.versao_orgao.findFirst({ where: { igreja_id: c.igreja_id, orgao_id: c.orgao_id!, ...periodoOrgao(data) }, select: { configuracao: true } }),
    ]) : [[], null];
    const regra = regrasSociedade.safeParse(configuracaoOrgao(versao?.configuracao).regra_sociedade);
    const socios = new Set(membros.filter(m => regra.success && cabeNaFaixa(regra.data, m.pessoa.data_nascimento, referencia)).map(m => m.pessoa_id));
    const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: c.igreja_id, pessoa_id: { in: [...candidatos] }, data_evento: { lte: data } },
      select: { pessoa_id: true, data_evento: true, ordem_dia: true, rol: true } });
    for (const [id, historico] of agruparPorPessoa(eventos)) {
      const rol = eventoVigente(historico, data);
      if (rol.situacao !== 'DEFINIDO') continue;
      for (const o of cargos.get(id) ?? []) {
        const supervisao = ['CONSELHEIRO', 'ORIENTADOR'].includes(o.cargo.codigo);
        if (sociedade && !supervisao) {
          if (socios.has(id) && ['COMUNGANTES', 'NAO_COMUNGANTES'].includes(rol.evento.rol)) porPessoa.get(id)!.add(o.cargo_id);
        } else if (rol.evento.rol === 'COMUNGANTES' && (!conselho || o.cargo.funcao === 'TESOUREIRO' || o.cargo.codigo === 'TESOUREIRO')) {
          porPessoa.get(id)!.add(o.cargo_id);
        }
      }
    }
    return porPessoa;
  }

  async podeAgendar(tx: Tx, c: Contexto, pessoa: string | null) {
    if (c.orgao?.tipo === 'UNIDADE_MINISTERIAL') return c.orgao.ativo;
    const papeis = await this.papeis(tx, c, pessoa);
    if (papeis.has('PRESIDENCIA_CONSELHO')) return true;
    if (!papeis.size) return false;
    if (c.orgao?.tipo === 'JUNTA' && await tx.cargo_orgao.findFirst({ where: {
      id: { in: [...papeis] }, orgao_id: c.orgao_id!, codigo: 'PRESIDENTE', ativo: true,
    } })) return true;
    const modelos = await tx.modelo_documento.findMany({ where: { igreja_id: c.igreja_id, contexto_id: c.id, rascunho: null },
      select: { versoes: { orderBy: { numero: 'desc' }, take: 1, select: { finalidade: true, configuracao: true } } } });
    return modelos.some(({ versoes: [v] }) => {
      if (v?.finalidade !== 'CONVOCACAO') return false;
      const config = configuracaoSchema.safeParse(v.configuracao);
      return config.success && permissoesModelo(config.data.atuacao, papeis).criar;
    });
  }

  async exigir(tx: Tx, c: Contexto, pessoa: string | null, regra: Regra, acao: AcaoModelo) {
    const p = permissoesModelo(regra, await this.papeis(tx, c, pessoa));
    if (!(acao === 'editar' ? p.criar || p.preparar : p[acao]))
      throw new ForbiddenException('Seu cargo em exercício não está habilitado para esta ação no modelo.');
  }

  async sugerirArrolados(tx: Tx, c: Contexto, config: ConfiguracaoModelo, dia: string,
    participantes: { presente: boolean; pessoa_id: string; papeis: string[] }[]) {
    const presentes = participantes.filter(p => p.presente);
    const exigidos = new Set([...(config.atuacao?.assinar ?? []), ...config.cargos_obrigatorios]);
    const substituicao = config.atuacao?.substituicao_assinatura;
    const exigeInstitucional = [...exigidos].some(id => !mesa.some(p => p.id === id));
    const porCargo = exigeInstitucional ? await this.papeisPorPessoa(tx, c, presentes.map(p => p.pessoa_id), dia) : new Map<string, Set<string>>();
    const titularPresente = substituicao && [...porCargo.values()].some(cargos => cargos.has(substituicao.titular));
    return presentes.map(p => {
      const mesa = p.papeis.filter(papel => ['PRESIDENTE','SECRETARIO'].includes(papel));
      const ocupados = porCargo.get(p.pessoa_id);
      const cargos = [...ocupados ?? []].filter(id => exigidos.has(id));
      const substitui = !!substituicao && !titularPresente && ocupados?.has(substituicao.substituto) === true;
      const obrigatorio = config.assinaturas_reuniao === 'PRESENTES' || (config.assinaturas_reuniao === 'MESA' && mesa.length > 0) ||
        substitui || cargos.length > 0 || p.papeis.some(papel => config.papeis_obrigatorios.includes(papel)) || mesa.some(papel => exigidos.has(papel + '_MESA'));
      return { pessoa_id: p.pessoa_id, papeis: [...new Set(p.papeis)], cargo_id: null,
        cargos_ids: cargos.filter(id => config.cargos_obrigatorios.includes(id)), assina: obrigatorio, obrigatorio, responsavel: false,
        fundamento: obrigatorio ? 'Presença confirmada e assinatura prevista no modelo da ata.' : '' };
    });
  }

  async conferirCargosArrolados(tx: Tx, c: Contexto, entrada: VersaoInput) {
    const indicacoes = entrada.conteudo.arrolados.flatMap(p => cargosDoArrolado(p).map(cargo => ({ pessoa: p.pessoa_id, cargo })));
    if (!indicacoes.length) return;
    if (!c.orgao_id) throw new BadRequestException('Este contexto não possui cargos de órgão para arrolar.');
    const dia = new Date(entrada.data_documento + 'T00:00:00Z');
    const pessoas = [...new Set(indicacoes.map(i => i.pessoa))];
    const ocupacoes = await tx.ocupacao_cargo.findMany({ where: {
      igreja_id: c.igreja_id, orgao_id: c.orgao_id, pessoa_id: { in: pessoas },
      cargo_id: { in: [...new Set(indicacoes.map(i => i.cargo))] },
      inicio: { lte: dia }, OR: [{ fim: null }, { fim: { gt: dia } }],
      AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: dia } }] }],
    }, select: { pessoa_id: true, cargo_id: true } });
    const porPessoa = agruparPorPessoa(ocupacoes);
    const papeis = await this.papeisPorPessoa(tx, c, pessoas, entrada.data_documento);
    for (const { pessoa, cargo } of indicacoes) {
      if (porPessoa.get(pessoa)?.filter(o => o.cargo_id === cargo).length !== 1)
        throw new BadRequestException('Ocupação do cargo ausente ou indeterminada na data do ato.');
      if (!papeis.get(pessoa)?.has(cargo))
        throw new BadRequestException('Exercício institucional do signatário não confirmado.');
    }
  }

  async conferirAssinaturas(tx: Tx, c: Contexto, regra: Regra, entrada: VersaoInput) {
    if (!regra?.assinar.length) return;
    const faltam = new Set(regra.assinar);
    const participantes = entrada.reuniao_id && c.tipo === 'ASSEMBLEIA_GERAL' ? await tx.participante_reuniao.findMany({
      where: { igreja_id: c.igreja_id, contexto_id: c.id, reuniao_id: entrada.reuniao_id, presente: true },
      select: { pessoa_id: true, papeis: true },
    }) : [];
    const signatarios = entrada.conteudo.arrolados.filter(p => p.assina && p.obrigatorio);
    const exigeInstitucional = [...faltam].some(id => !mesa.some(papel => papel.id === id));
    const cargos = exigeInstitucional ? await this.papeisPorPessoa(tx, c, signatarios.map(p => p.pessoa_id), entrada.data_documento) : null;
    const r = entrada.reuniao_id && c.tipo === 'ASSEMBLEIA_GERAL' ? await tx.reuniao.findFirst({
      where: { id: entrada.reuniao_id, contexto_id: c.id, igreja_id: c.igreja_id },
      select: { id: true, contexto_id: true, igreja_id: true, instalacao_formal: true },
    }) : null;
    const instalada = r?.instalacao_formal ? await mesaVigente(tx, r) : null;
    const mesaConfirmada = mesa.map(({ id }) => {
      const papel = id.replace('_MESA', '');
      const titulares = participantes.filter(p => p.papeis.includes(papel));
      const pessoa = r?.instalacao_formal
        ? (papel === 'PRESIDENTE' ? instalada?.oficial.pessoa_id : instalada?.secretario_id) ?? null
        : titulares.length === 1 ? titulares[0].pessoa_id : null;
      return { id, papel, pessoa: participantes.some(p => p.pessoa_id === pessoa) ? pessoa : null };
    });
    for (const p of signatarios) {
      if (!faltam.size) break;
      const titulares = cargos?.get(p.pessoa_id) ?? new Set<string>();
      for (const id of titulares) faltam.delete(id);
      const substituicao = regra.substituicao_assinatura;
      if (substituicao && titulares.has(substituicao.substituto)) faltam.delete(substituicao.titular);
      for (const m of mesaConfirmada) {
        if (m.pessoa === p.pessoa_id && p.papeis.includes(m.papel)) faltam.delete(m.id);
      }
    }
    if (faltam.size) {
      const opcoes = await opcoesAtuacao(tx, c);
      const nomes = [...faltam].map(id => opcoes.find(p => p.id === id)?.nome ?? 'cargo indisponível');
      throw new BadRequestException('Falta assinatura obrigatória do titular em exercício: ' + nomes.join(', ') + '.');
    }
  }
}
