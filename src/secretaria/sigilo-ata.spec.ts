import type { Prisma } from '@prisma/client';
import { composicaoNaTransacao } from '../orgaos/composicao.service';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { regraPadrao } from '../orgaos/sociedades-regras';
import { permissoesAtas, permissoesAtasDaConta } from './sigilo-ata';

jest.mock('../orgaos/composicao.service', () => ({ composicaoNaTransacao: jest.fn() }));
jest.mock('../orgaos/relogio-igreja', () => ({ hojeDaIgreja: jest.fn() }));
const dia = '2026-11-26';
const orgaos = [
  { id: 'conselho', tipo: 'CONSELHO', ativo: true, contexto_secretaria: { id: 'atas-conselho' } },
  { id: 'junta', tipo: 'JUNTA', ativo: true, contexto_secretaria: { id: 'atas-junta' } },
  { id: 'saf', tipo: 'SOCIEDADE_INTERNA', ativo: true, contexto_secretaria: { id: 'atas-saf' } },
  { id: 'unidade', tipo: 'UNIDADE_MINISTERIAL', ativo: true, contexto_secretaria: { id: 'atas-unidade' } },
  { id: 'arquivo', tipo: 'UNIDADE_MINISTERIAL', ativo: false, contexto_secretaria: { id: 'atas-arquivo' } },
];
const leitura = { ler: true, classificar: false };
const classificacao = { ler: true, classificar: true };
const pessoa = 'pessoa';
const igreja = 'igreja';
const txTeste = () => {
  const mocks = {
    orgao_interno: { findMany: jest.fn().mockResolvedValue(orgaos) },
    oficial: { findFirst: jest.fn().mockResolvedValue({ id: 'oficio-ativo' }) },
    usuarios: { findFirst: jest.fn().mockResolvedValue({ pessoa_id: pessoa }) },
    ocupacao_cargo: { findMany: jest.fn().mockResolvedValue([]) },
    eventos_membresia: { findMany: jest.fn().mockResolvedValue([{ data_evento: new Date('2019-01-01'), rol: 'COMUNGANTES' }]) },
    versao_orgao: { findFirst: jest.fn().mockResolvedValue({ configuracao: { regra_sociedade: regraPadrao('SAF') } }) },
    membro_orgao: { findFirst: jest.fn().mockResolvedValue({ pessoa: { data_nascimento: new Date('1980-01-01') } }) },
  };
  return { ...mocks, tx: mocks as unknown as Prisma.TransactionClient };
};

type Composicao = Awaited<ReturnType<typeof composicaoNaTransacao>>;
function membro(tipo: 'CONSELHO' | 'JUNTA', situacao?: 'REVISAR' | 'INDETERMINADA') {
  jest.mocked(composicaoNaTransacao).mockImplementation(async (_tx, _igreja, orgao): Promise<Composicao> => ({
    data_referencia: dia,
    membros: orgao === tipo ? [{ pessoa_id: pessoa, oficios: [tipo === 'CONSELHO' ? 'PRESBITERO_REGENTE' : 'DIACONO'],
      revisao_pendente: situacao === 'REVISAR' }] : [],
    situacao_indeterminada: orgao === tipo && situacao === 'INDETERMINADA' ? [pessoa] : [],
  }));
}
function ocupacao(orgao_id: string, codigo: string, funcao = 'OUTRO', nome = codigo) {
  return { orgao_id, cargo: { codigo, funcao, nome } };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(hojeDaIgreja).mockResolvedValue(dia);
  jest.mocked(composicaoNaTransacao).mockResolvedValue({ data_referencia: dia, membros: [], situacao_indeterminada: [] });
});

describe('acesso institucional às atas restritas', () => {
  it('concede a qualquer integrante do Conselho acesso a todos os contextos de sua igreja, incluindo o acervo inativo', async () => {
    const { tx, orgao_interno } = txTeste();
    membro('CONSELHO');
    expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(new Map(orgaos.map(o => [o.contexto_secretaria.id, classificacao])));
    expect(orgao_interno.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ igreja_id: igreja }) }));
    expect(composicaoNaTransacao).toHaveBeenCalledWith(tx, igreja, 'CONSELHO', dia, [pessoa], 'conselho');
  });

  it('rejeita ofício arquivado mesmo havendo mandato e ordenação históricos', async () => {
    const { tx, oficial } = txTeste();
    membro('CONSELHO');
    oficial.findFirst.mockResolvedValue(null);
    expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(new Map());
    expect(oficial.findFirst).toHaveBeenCalledWith({ where: { igreja_id: igreja, pessoa_id: pessoa, tipo: { in: ['PRESBITERO_REGENTE'] }, ativo: true }, select: { id: true } });
  });

  it.each(['REVISAR', 'INDETERMINADA'] as const)('nega o acesso do mandato quando a composição indica %s', async situacao => {
    const { tx } = txTeste();
    membro('CONSELHO', situacao);
    expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(new Map());
  });

  it.each([
    [null, leitura], ['VICE_PRESIDENTE', leitura], ['PRESIDENTE', classificacao], ['SEGUNDO_SECRETARIO', classificacao],
  ] as const)('distingue leitura e classificação na Junta para o cargo %s', async (codigo, permissao) => {
    const { tx, ocupacao_cargo } = txTeste();
    membro('JUNTA');
    if (codigo) ocupacao_cargo.findMany.mockResolvedValue([ocupacao('junta', codigo)]);
    expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(new Map([['atas-junta', permissao]]));
    expect(composicaoNaTransacao).toHaveBeenCalledWith(tx, igreja, 'JUNTA', dia, [pessoa], 'junta');
  });

  it('não concede acesso a um secretário da Junta que já saiu do exercício diaconal', async () => {
    const { tx, ocupacao_cargo } = txTeste();
    ocupacao_cargo.findMany.mockResolvedValue([ocupacao('junta', 'SECRETARIO')]);
    expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(new Map());
  });

  it.each([
    ['TESOUREIRO', leitura], ['SECRETARIO', classificacao], ['PRESIDENTE', classificacao], ['CONSELHEIRO', undefined], ['ORIENTADOR', undefined],
  ])('limita a diretoria da SAF ao próprio órgão e distingue o cargo %s', async (codigo: string, permissao) => {
    const { tx, ocupacao_cargo } = txTeste();
    ocupacao_cargo.findMany.mockResolvedValue([ocupacao('saf', codigo)]);
    expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(permissao ? new Map([['atas-saf', permissao]]) : new Map());
    const data = new Date(dia);
    expect(ocupacao_cargo.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      igreja_id: igreja, pessoa_id: pessoa, inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }],
      AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }],
    }) }));
  });

  it.each([['Secretária', true], ['Presidente', true], ['Vice-presidente', false], ['Secretaria de Eventos', false]])(
    'verifica pelo título exato o cargo livre de ministério %s', async (nome: string, classificar: boolean) => {
      const { tx, ocupacao_cargo } = txTeste();
      ocupacao_cargo.findMany.mockResolvedValue([ocupacao('unidade', 'MINISTERIO_2', 'OUTRO', nome)]);
      expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(new Map([['atas-unidade', { ler: true, classificar }]]));
    });

  it('nega acesso de ex-sócia e de sócia sem cargo na diretoria', async () => {
    const { tx, ocupacao_cargo, membro_orgao } = txTeste();
    expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(new Map());
    ocupacao_cargo.findMany.mockResolvedValue([ocupacao('saf', 'SECRETARIO')]);
    membro_orgao.findFirst.mockResolvedValue(null);
    expect(await permissoesAtas(tx, igreja, pessoa)).toEqual(new Map());
  });

  it('consulta apenas conta ativa da própria igreja e exige vínculo pessoal, inclusive para administrador', async () => {
    const { tx, usuarios, orgao_interno } = txTeste();
    usuarios.findFirst.mockResolvedValueOnce(null);
    expect(await permissoesAtasDaConta(tx, igreja, 'usuario')).toEqual(new Map());
    expect(usuarios.findFirst).toHaveBeenCalledWith({ where: { id: 'usuario', igreja_id: igreja, ativo: true }, select: { pessoa_id: true } });
    expect(orgao_interno.findMany).not.toHaveBeenCalled();
    expect(await permissoesAtasDaConta(tx, igreja, 'administrador')).toEqual(new Map());
  });
});
