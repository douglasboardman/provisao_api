/** Ações delegáveis no escopo da igreja da conta. Os serviços institucionais
 * complementam a política do recurso e mantêm as verificações do ato. */
export const gruposServico = {
  pessoas: { view: 'PESSOAS_CONSULTAR', create: 'PESSOAS_CADASTRAR', edit: 'PESSOAS_EDITAR', delete: 'PESSOAS_EXCLUIR' },
  'grupos-familiares': { view: 'FAMILIAS_CONSULTAR', create: 'FAMILIAS_CADASTRAR', edit: 'FAMILIAS_EDITAR', delete: 'FAMILIAS_EXCLUIR' },
  'eventos-membresia': { view: 'MEMBRESIA_CONSULTAR', create: 'MEMBRESIA_REGISTRAR', edit: 'MEMBRESIA_EDITAR', delete: 'MEMBRESIA_EXCLUIR' },
  profissoes: { view: 'PROFISSOES_CONSULTAR', create: 'PROFISSOES_CADASTRAR', edit: 'PROFISSOES_EDITAR', delete: 'PROFISSOES_EXCLUIR' },
  tratamentos: { view: 'TRATAMENTOS_CONSULTAR' },
  igreja: { view: 'IGREJA_CONSULTAR', edit: 'IGREJA_EDITAR' },
  usuarios: { view: 'USUARIOS_CONSULTAR' },
  'solicitacoes-acesso': { view: 'ACESSO_CONSULTAR', edit: 'ACESSO_ANALISAR' },
  logs: { view: 'AUDITORIA_CONSULTAR' },
  'regras-relacao-enum': { view: 'PARAMETROS_CONSULTAR', edit: 'PARAMETROS_EDITAR' },
  acoes: { view: 'ACOES_CONSULTAR', create: 'ACOES_CADASTRAR', edit: 'ACOES_EDITAR', delete: 'ACOES_EXCLUIR' },
  contas: { view: 'CONTAS_CONSULTAR', create: 'CONTAS_CADASTRAR', edit: 'CONTAS_EDITAR', delete: 'CONTAS_EXCLUIR' },
  'cat-receita': { view: 'CATEGORIAS_RECEITA_CONSULTAR', create: 'CATEGORIAS_RECEITA_CADASTRAR', edit: 'CATEGORIAS_RECEITA_EDITAR', delete: 'CATEGORIAS_RECEITA_EXCLUIR' },
  'cat-despesa': { view: 'CATEGORIAS_DESPESA_CONSULTAR', create: 'CATEGORIAS_DESPESA_CADASTRAR', edit: 'CATEGORIAS_DESPESA_EDITAR', delete: 'CATEGORIAS_DESPESA_EXCLUIR' },
  receitas: { view: 'RECEITAS_CONSULTAR', create: 'RECEITAS_CADASTRAR', edit: 'RECEITAS_EDITAR', delete: 'RECEITAS_EXCLUIR' },
  despesas: { view: 'DESPESAS_CONSULTAR', create: 'DESPESAS_CADASTRAR', edit: 'DESPESAS_EDITAR', delete: 'DESPESAS_EXCLUIR' },
  lancamentos: { view: 'LANCAMENTOS_CONSULTAR', create: 'LANCAMENTOS_REGISTRAR', edit: 'LANCAMENTOS_EDITAR', delete: 'LANCAMENTOS_EXCLUIR' },
  'balanco-mensal': { view: 'BALANCO_CONSULTAR' },
  'autorizacoes-financeiras': { view: 'AUTORIZACOES_FINANCEIRAS_CONSULTAR', create: 'AUTORIZACOES_FINANCEIRAS_REGISTRAR' },
  oficiais: { view: 'OFICIAIS_CONSULTAR' },
  orgaos: { view: 'ORGAOS_CONSULTAR' },
} as const;

export const servicosInstitucionais = ['PRESIDENCIA_CONFERIR', 'MANDATOS_REGISTRAR', 'CARGOS_REGISTRAR'] as const;
export const servicosDeHistorico = [
  'HISTORICO_MEMBRESIA_CONSULTAR', 'HISTORICO_MEMBRESIA_RETIFICAR',
  'HISTORICO_OFICIAIS_CONSULTAR', 'HISTORICO_OFICIAIS_REGISTRAR',
  'REVISOES_ELEITORAIS_DECIDIR',
] as const;
export const servicosAdicionais = ['VINCULOS_DOCUMENTAIS_CONSULTAR', 'VINCULOS_DOCUMENTAIS_REGISTRAR', ...servicosDeHistorico] as const;
type Valores<T> = T extends unknown ? T[keyof T] : never;
type ModuloServico = keyof typeof gruposServico;
type ServicoDeModulo = Valores<(typeof gruposServico)[ModuloServico]>;
type ServicoComplementar = (typeof servicosInstitucionais)[number] | (typeof servicosAdicionais)[number];
export type Servico = ServicoDeModulo | ServicoComplementar;
type AreaServico = 'pessoas-membresia' | 'financeiro' | 'institucional' | 'administracao';

const areasDosModulos: Record<ModuloServico, AreaServico> = {
  pessoas: 'pessoas-membresia', 'grupos-familiares': 'pessoas-membresia', 'eventos-membresia': 'pessoas-membresia',
  profissoes: 'pessoas-membresia', tratamentos: 'pessoas-membresia', 'regras-relacao-enum': 'pessoas-membresia',
  contas: 'financeiro', 'cat-receita': 'financeiro', 'cat-despesa': 'financeiro', receitas: 'financeiro',
  despesas: 'financeiro', lancamentos: 'financeiro', 'balanco-mensal': 'financeiro', 'autorizacoes-financeiras': 'financeiro',
  oficiais: 'institucional', orgaos: 'institucional',
  igreja: 'administracao', usuarios: 'administracao', 'solicitacoes-acesso': 'administracao', logs: 'administracao', acoes: 'administracao',
};
const areasComplementares: Record<ServicoComplementar, AreaServico> = {
  HISTORICO_MEMBRESIA_CONSULTAR: 'pessoas-membresia',
  HISTORICO_MEMBRESIA_RETIFICAR: 'pessoas-membresia',
  PRESIDENCIA_CONFERIR: 'institucional',
  MANDATOS_REGISTRAR: 'institucional',
  CARGOS_REGISTRAR: 'institucional',
  VINCULOS_DOCUMENTAIS_CONSULTAR: 'institucional',
  VINCULOS_DOCUMENTAIS_REGISTRAR: 'institucional',
  HISTORICO_OFICIAIS_CONSULTAR: 'institucional',
  HISTORICO_OFICIAIS_REGISTRAR: 'institucional',
  REVISOES_ELEITORAIS_DECIDIR: 'institucional',
};
export const areasServico: Record<Servico, AreaServico> = {
  ...Object.fromEntries((Object.keys(gruposServico) as ModuloServico[]).flatMap(modulo =>
    Object.values(gruposServico[modulo]).map(acao => [acao, areasDosModulos[modulo]]))) as Record<ServicoDeModulo, AreaServico>,
  ...areasComplementares,
};

export const servicosDeConsulta = new Set<Servico>([
  ...Object.values(gruposServico).map(g => g.view), 'VINCULOS_DOCUMENTAIS_CONSULTAR',
  'HISTORICO_MEMBRESIA_CONSULTAR', 'HISTORICO_OFICIAIS_CONSULTAR',
]);
export const codigosServico = [
  ...Object.values(gruposServico).flatMap(g => Object.values(g)),
  ...servicosInstitucionais, ...servicosAdicionais,
] as Servico[];

const titulos: Record<keyof typeof gruposServico, string> = {
  pessoas: 'pessoas', 'grupos-familiares': 'famílias', 'eventos-membresia': 'membresia',
  profissoes: 'profissões', tratamentos: 'tratamentos', igreja: 'cadastro da igreja', usuarios: 'contas de usuário',
  'solicitacoes-acesso': 'solicitações de acesso', logs: 'auditoria', 'regras-relacao-enum': 'parâmetros locais de membresia',
  acoes: 'projetos', contas: 'contas financeiras', 'cat-receita': 'categorias de receita', 'cat-despesa': 'categorias de despesa',
  receitas: 'tipos de receita', despesas: 'tipos de despesa', lancamentos: 'lançamentos', 'balanco-mensal': 'balanço mensal',
  'autorizacoes-financeiras': 'autorizações financeiras documentais', oficiais: 'oficiais', orgaos: 'estrutura institucional',
};
const verbos = { view: 'Consultar', create: 'Registrar', edit: 'Alterar', delete: 'Excluir' };
export const rotulosServico: Record<string, string> = {
  ...Object.fromEntries(Object.entries(gruposServico).flatMap(([modulo, acoes]) =>
    Object.entries(acoes).map(([verbo, acao]) => [acao, verbos[verbo] + ' ' + titulos[modulo]]))),
  ACESSO_ANALISAR: 'Analisar solicitações de acesso',
  CARGOS_REGISTRAR: 'Registrar eleição, posse e encerramento de cargos',
  MANDATOS_REGISTRAR: 'Registrar e encerrar mandatos de oficiais',
  PRESIDENCIA_CONFERIR: 'Conferir a comprovação da presidência',
  VINCULOS_DOCUMENTAIS_CONSULTAR: 'Consultar vínculos documentais',
  VINCULOS_DOCUMENTAIS_REGISTRAR: 'Registrar vínculos documentais',
  HISTORICO_MEMBRESIA_CONSULTAR: 'Consultar histórico de retificações da membresia',
  HISTORICO_MEMBRESIA_RETIFICAR: 'Retificar registros históricos da membresia',
  HISTORICO_OFICIAIS_CONSULTAR: 'Consultar histórico de oficiais',
  HISTORICO_OFICIAIS_REGISTRAR: 'Registrar fatos históricos de oficiais',
  REVISOES_ELEITORAIS_DECIDIR: 'Registrar decisões de revisão eleitoral',
};
