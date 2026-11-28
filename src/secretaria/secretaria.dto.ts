import { reatribuicaoAtosSchema } from './referencias-ata.dto';
import { rascunhoEfetivos, retratoModeloReuniao } from './regras-modelo-reuniao';
import { camposNumeracao } from './numeracao-campos';
import { camposDataHoraReuniao } from './data-reuniao';
import { BadRequestException } from '@nestjs/common';
import { paragrafos, paginaTextoSchema, valoresPaginaSchema } from './composicao-pagina';
import { camposEndereco } from './local-reuniao';
import { z } from 'zod';
import { resolucoesSchema } from './resolucoes.dto';

export const dia = z.iso.date();
export const texto = z.string().trim().min(1).max(1000);
export const nome = z.string().trim().min(1).max(255);
export const codigo = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
export const chave = { idempotencia: z.uuid() };
export const revisao = { revisao: z.number().int().positive() };
export const contextoSchema = z.object({ ...chave, tipo: z.enum(['ORGAO', 'ASSEMBLEIA_GERAL']), orgao_id: z.uuid().optional(), nome, sigla: z.string().trim().regex(/^[A-Z0-9-]{1,40}$/) }).strict();
export const competenciaSchema = z.object({ ...chave, contexto_id: z.uuid(), usuario_id: z.uuid(), inicio: dia, fim: dia.nullable().default(null), pode_instalar_mesa: z.boolean().default(false), pode_aprovar: z.boolean(), pode_deliberar: z.boolean(), pode_consultar_restritos: z.boolean(), autoridade: nome, evidencia: texto }).strict().refine(v => !v.fim || v.fim > v.inicio, 'Período inválido.');
export const fimCompetenciaSchema = z.object({ ...chave, fim: dia, autoridade: nome, evidencia: texto }).strict();
const politica = z.enum(['NAO_PERMITE', 'OPCIONAL', 'OBRIGATORIO']);
const alinhamento = z.enum(['ESQUERDA', 'CENTRO', 'DIREITA', 'JUSTIFICADO']);
const tipoCampo = z.enum(['TEXTO', 'DATA', 'NUMERO', 'SIM_NAO']);
export type TipoCampo = z.infer<typeof tipoCampo>;
const bloco = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('TEXTO'), texto: z.string().max(20000), alinhamento, estilo: z.enum(['NORMAL', 'TITULO', 'SUBTITULO']), rico: z.boolean().optional() }).strict(),
  z.object({ tipo: z.literal('LISTA'), itens: z.array(z.string().max(2000)).max(100), ordenada: z.boolean() }).strict(),
  z.object({ tipo: z.literal('TABELA'), linhas: z.array(z.array(z.string().max(2000)).min(1).max(12)).min(1).max(100), primeira_linha_cabecalho: z.boolean().optional() }).strict(),
  z.object({ tipo: z.literal('IMAGEM'), arquivo_id: z.uuid(), descricao: z.string().max(255) }).strict(),
  z.object({ tipo: z.literal('QUEBRA') }).strict(),
  z.object({ tipo: z.literal('ASSINATURAS') }).strict(),
]);
export const estruturaSchema = z.object({ cabecalho: z.array(bloco).max(30), corpo: z.array(bloco).max(200), rodape: z.array(bloco).max(30) }).strict().refine(v => JSON.stringify(v).length <= 200000, 'Estrutura excede o limite permitido.');
export const camposDeCadastro = ['contexto_nome', 'contexto_sigla', 'contexto_por_extenso', 'data_prevista_reuniao', 'horario_previsto_reuniao', 'horario_previsto_reuniao_por_extenso', 'numero_livro', 'titular_livro', 'serie_livro', 'capacidade_folhas_livro', 'modalidade_livro', 'nome_convocante', 'nome_preparador', 'nome_secretario_livro', 'nome_presidente_mesa', 'nome_secretario_mesa'] as const;
export const definicaoCampo = z.strictObject({
  nome: z.string().trim().min(1).max(120), tipo: z.enum(['texto','numero','data','sim_nao']),
  multiplo: z.boolean(), origem: z.enum(['manual','igreja','assunto','data_documento','redator_ata','local_reuniao','presentes','pauta_reuniao','deliberacoes_reuniao',...camposDeCadastro, ...camposNumeracao, ...camposDataHoraReuniao, ...camposEndereco]),
});
export const criarCampoSchema = definicaoCampo.extend(chave);
export const editarCampoSchema = criarCampoSchema.extend({ ...revisao, ativo: z.boolean() });
const regraAntecedente = z.strictObject({
  modelo_id: z.uuid(),
  // Chave = campo do destino. Valor = campo correspondente no modelo anterior.
  campos: z.record(z.uuid(), z.uuid()).refine(v => Object.keys(v).length <= 100),
});
const papelAtuacao = z.union([z.uuid(), z.enum(['PRESIDENCIA_CONSELHO', 'PRESIDENTE_MESA', 'SECRETARIO_MESA'])]);
const listaPapeis = z.array(papelAtuacao).max(50).refine(v => new Set(v).size === v.length, 'Papel duplicado.');
export const atuacaoModeloSchema = z.strictObject({
  criar: listaPapeis, preparar: listaPapeis, assinar: listaPapeis,
  substituicao_assinatura: z.strictObject({ titular: z.uuid(), substituto: z.uuid() }).optional(),
});
export const configuracaoSchema = z.object({
  atuacao: atuacaoModeloSchema.optional(), vinculo_reuniao: politica.optional(),
  perfil: codigo, contexto: z.enum(['ORGAO', 'ASSEMBLEIA_GERAL']),
  tipos_orgao: z.array(z.enum(['CONSELHO', 'JUNTA', 'UNIDADE_MINISTERIAL', 'SOCIEDADE_INTERNA'])).max(4).default([]),
  constituicoes: z.array(z.enum(['OFICIAL', 'ELEICAO', 'DESIGNACAO'])).max(3).default([]),
  assinaturas_reuniao: z.enum(['CARGOS', 'MESA', 'PRESENTES']).optional(),
  motivador: politica, resolucoes: politica, registro_livro: z.boolean().default(false), registro_em_livro: politica.optional(),
  campos_obrigatorios: z.array(codigo).max(50), papeis_obrigatorios: z.array(codigo).max(30),
  cargos_obrigatorios: z.array(z.uuid()).max(30),
  tipos_campos: z.record(codigo, tipoCampo).refine(v => Object.keys(v).length <= 50, 'Até 50 campos tipados.').optional(),
  antecedentes: z.array(regraAntecedente).max(30).optional(),
  definicoes: z.record(z.uuid(), definicaoCampo.extend({ mapeamento: z.strictObject({ cadastro: z.string(), propriedade: z.string(), transformacao: z.string().nullable() }).optional() })).optional(), obrigatorios_biblioteca: z.array(z.uuid()).max(100).optional(),
  estrutura_padrao: estruturaSchema.optional(), composicao_padrao: paginaTextoSchema.optional(),
}).strict().refine(v => !(v.estrutura_padrao && v.composicao_padrao), 'Escolha uma estrutura para o modelo.');
const modelo = { tipo: z.enum(['ATA', 'OUTRO']), finalidade: codigo, configuracao: configuracaoSchema };
export const modeloSchema = z.object({ ...chave, contexto_id: z.uuid(), nome, publicar: z.boolean().optional(), ...modelo }).strict();
export const modeloVersaoSchema = z.object({ ...chave, ...revisao, nome: nome.optional(), ...modelo }).strict();
const participante = z.object({ pessoa_id: z.uuid(), presente: z.boolean(), papeis: z.array(codigo).min(1).max(20), pode_propor: z.boolean().optional() }).strict();
export const modalidadeReuniaoSchema = z.enum(['ORDINARIA', 'EXTRAORDINARIA', 'REGULAR', 'AGO', 'AGE']);
const dadosReuniao = z.strictObject({
  modelo_reuniao_id: z.uuid().optional(), modelo_reuniao: retratoModeloReuniao.optional(),
  formato: z.enum(['Presencial','Virtual','Híbrida']).optional(), carater: z.enum(['Regular','Urgente']).optional(),
  convocacao: z.enum(['Primeira','Segunda']).optional(), primeira_reuniao_id: z.uuid().nullable().optional(),
  total_presentes: z.number().int().nonnegative().nullable().optional(), local_efetivo: z.string().max(255).optional(),
  restrito: z.boolean(), modalidade: modalidadeReuniaoSchema, data: dia,
  situacao: z.enum(['AGENDADA', 'EM_ANDAMENTO', 'ENCERRADA', 'ADIADA', 'CANCELADA','NAO_INSTALADA']).optional(),
  horario_previsto: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  local: nome, inicio: z.iso.datetime({ offset: true }).nullable().default(null), fim: z.iso.datetime({ offset: true }).nullable().default(null),
  pauta: z.string().trim().min(1).max(20000), competencia: z.string().trim().max(1000).default(''),
  universo_informado: z.number().int().nonnegative().max(1000000), quorum_minimo: z.number().int().nonnegative().max(1000000),
  quorum_conferido: z.boolean().default(false), fundamento_quorum: z.string().trim().max(1500).default(''),
  resultado: z.string().trim().max(20000), participantes: z.array(participante).max(1000),
});
function conferirReuniao(v: Pick<z.infer<typeof dadosReuniao>, 'quorum_minimo' | 'universo_informado' | 'inicio' | 'fim' | 'situacao' | 'horario_previsto' | 'competencia' | 'fundamento_quorum' | 'quorum_conferido' | 'participantes' | 'resultado'>, ctx: z.RefinementCtx) {
  const invalidar = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.situacao === 'AGENDADA' && !v.horario_previsto) invalidar('Informe o horário previsto.');
  if (v.situacao === 'EM_ANDAMENTO' && v.fim) invalidar('Informe a abertura e registre o fim ao encerrar.');

  if (v.situacao === 'AGENDADA' && (v.inicio || v.fim || v.quorum_conferido || v.resultado || v.participantes.some(p => p.presente))) invalidar('Altere a situação para registrar a realização da reunião.');
  if (v.quorum_minimo > v.universo_informado) ctx.addIssue({ code: 'custom', message: 'Quórum maior que universo.' });
  if (v.inicio && v.fim && new Date(v.fim) < new Date(v.inicio)) ctx.addIssue({ code: 'custom', message: 'Horários inválidos.' });
}
export const reuniaoDadosSchema = dadosReuniao.superRefine(conferirReuniao);
const itensPauta = z.array(z.strictObject({
  id: z.uuid().optional(), descricao: z.string().trim().min(1).max(20000), proponente_id: z.uuid().nullable(),
})).min(1).max(200);

const entradaReuniao = z.preprocess(valor => {
  if (!valor || typeof valor !== 'object' || !('itens_pauta' in valor)) return valor;
  const itens = itensPauta.safeParse(valor.itens_pauta);
  if (!itens.success) return valor;
  const agendamento = 'situacao' in valor && valor.situacao === 'AGENDADA'
    ? { participantes: [], universo_informado: 0, quorum_minimo: 0, quorum_conferido: false, resultado: '' } : {};
  return { ...agendamento, ...valor, pauta: itens.data.map(item => item.descricao).join('\n') };
}, dadosReuniao.extend({ itens_pauta: itensPauta.optional(), local: nome.default('') }).superRefine(conferirReuniao));

export const reuniaoSchema = z.object({ ...chave, contexto_id: z.uuid(), local_id: z.uuid().optional(), local_efetivo_id: z.uuid().nullable().optional(), dados: entradaReuniao }).strict().refine(v => !!v.local_id || !!v.dados.local, 'Selecione o local da reunião.');
export const editarReuniaoSchema = z.object({ ...chave, ...revisao, local_id: z.uuid().optional(), local_efetivo_id: z.uuid().nullable().optional(), dados: entradaReuniao }).strict().refine(v => !!v.local_id || !!v.dados.local, 'Selecione o local da reunião.');
const arrolado = z.object({ pessoa_id: z.uuid(), papeis: z.array(codigo).min(1).max(30), cargo_id: z.uuid().nullable().default(null), cargos_ids: z.array(z.uuid()).max(30).default([]), assina: z.boolean(), obrigatorio: z.boolean(), responsavel: z.boolean(), fundamento: z.string().trim().max(1000) }).strict().refine(v => !v.obrigatorio || v.assina, 'Obrigatório deve assinar.');
export const conteudoSchema = z.object({
  autores_origem: z.strictObject({ preparador: z.uuid().nullable(), convocante: z.uuid().nullable() }).optional(),
  efetivos: rascunhoEfetivos.optional(),
  planejamento_origem: z.string().length(64).optional(),
  redator_ata: z.strictObject({ pessoa_id: z.uuid(), nome: nome.optional() }).nullable().optional(),
  teor: z.string().max(200000), campos: z.record(codigo, z.string().max(10000)).refine(v => Object.values(v).reduce((s, t) => s + t.length, 0) <= 60000 && Object.keys(v).length <= 100, 'Campos excedem o limite permitido.'),
  arrolados: z.array(arrolado).max(1000), anexos: z.array(z.object({ arquivo_id: z.uuid(), nome }).strict()).max(50),
  antecedente: z.strictObject({ versao_id: z.uuid(), identificacao: z.string().max(500) }).optional(),
  valores: valoresPaginaSchema.optional(), estrutura: estruturaSchema.optional(), composicao: paginaTextoSchema.optional(),
}).strict().refine(v => !(v.composicao && (v.estrutura || v.teor)), 'A página já contém o texto do documento.');
export const versaoSchema = z.object({ atualizar_fontes: z.string().length(64).optional(), confirmar_troca_livro: z.boolean().optional(), confirmar_troca_origem: z.boolean().optional(), modelo_versao_id: z.uuid(), livro_id: z.uuid().nullable().optional(), reuniao_id: z.uuid().nullable().default(null), motivador_id: z.uuid().nullable().default(null), assunto: nome, data_documento: dia, conteudo: conteudoSchema, resolucoes: resolucoesSchema.optional() }).strict();
export const consultaDocumentosSchema = z.strictObject({
  contexto: z.uuid(), pagina: z.coerce.number().int().min(0).max(100000).default(0),
  tipo: z.enum(['ATA', 'OUTRO']).optional(),
  visao: z.enum(['expedidos', 'andamento', 'todos']), busca: z.string().trim().max(255).optional(),
  modelo: z.uuid().optional(), de: dia.optional(), ate: dia.optional(),
  estado: z.enum(['EM_EDICAO', 'ENCAMINHADO', 'APROVADO', 'EXPEDIDO', 'ANULADO', 'CANCELADO', 'LEGADA_CONFERIDA']).optional(),
}).refine(v => !v.de || !v.ate || v.de <= v.ate, 'A data final deve ser igual ou posterior à inicial.');
export const documentoSchema = z.object({ ...chave, conferencia_abertura: z.string().length(64).optional(), retomar_convocacao: z.boolean().optional(), agendamento: z.strictObject({ local_id: z.uuid(), dados: entradaReuniao }).optional(), acao: z.enum(['criar', 'preparar']).optional(), usar_modelo_vigente: z.literal(true).optional(), contexto_id: z.uuid(), restrito: z.boolean(), versao: versaoSchema }).strict();
export const editarDocumentoSchema = z.object({ ...chave, ...revisao, versao: versaoSchema }).strict();
export const comandoSchema = z.object({ ...chave, ...revisao, autoridade: nome, evidencia: texto }).strict();
export const modalidadeAssinatura = z.enum(['ELETRONICA', 'FISICA']);
export const aprovacaoSchema = comandoSchema.extend({ modalidade: modalidadeAssinatura.optional() }).strict();
export const deliberacaoSchema = comandoSchema.extend({ reuniao_id: z.uuid(), resultado: z.enum(['APROVADA', 'REJEITADA', 'ADIADA']), data: dia }).strict();
export const retificarSchema = comandoSchema.extend({ versao: versaoSchema, reatribuicao_atos: reatribuicaoAtosSchema.optional() }).strict();
export function validar<T extends z.ZodType>(schema: T, dados: unknown): z.infer<T> {
  const v = schema.safeParse(dados);
  if (!v.success) throw new BadRequestException(v.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return v.data;
}
export type ConfiguracaoModelo = z.infer<typeof configuracaoSchema>;
export type VersaoInput = z.infer<typeof versaoSchema>;
export type ReuniaoInput = z.infer<typeof reuniaoDadosSchema>;

export function imagensDaEstrutura(estrutura?: VersaoInput['conteudo']['estrutura'], pagina?: VersaoInput['conteudo']['composicao']) {
  const blocos = [...(pagina?.cabecalho ?? []), ...(pagina?.corpo ?? []), ...(pagina?.rodape ?? [])];
  return [...Object.values(estrutura ?? {}).flat().filter(b => b.tipo === 'IMAGEM'),
    ...blocos.filter(b => b.tipo === 'imagem'),
    ...paragrafos(blocos).flatMap(p => p.trechos.filter(t => t.tipo === 'imagem'))];
}

export function validarCampos(config: ConfiguracaoModelo, campos: VersaoInput['conteudo']['campos']) {
  for (const [chave, tipo] of Object.entries(config.tipos_campos ?? {})) {
    const valor = campos[chave];
    if (!valor?.trim() || tipo === 'TEXTO') continue;
    const valido = tipo === 'DATA' ? dia.safeParse(valor).success :
      tipo === 'NUMERO' ? /^-?\d{1,15}(\.\d{1,6})?$/.test(valor) : ['SIM', 'NAO'].includes(valor);
    if (!valido) throw new BadRequestException(`Campo ${chave} inválido para o tipo ${tipo}.`);
  }
}

export function cargosDoArrolado(p: { cargo_id: string | null; cargos_ids: string[] }) {
  return [...new Set([...(p.cargo_id ? [p.cargo_id] : []), ...p.cargos_ids])];
}

export function politicaLivro(config: ConfiguracaoModelo) {
  return config.registro_em_livro ?? (config.registro_livro ? 'OBRIGATORIO' : 'NAO_PERMITE');
}

export function finalidadeTermo(finalidade?: string) {
  if (finalidade === 'TERMO_ABERTURA') return 'ABERTURA';
  if (finalidade === 'TERMO_ENCERRAMENTO') return 'ENCERRAMENTO';
  return null;
}

export const medicaoLivroSchema = z.object(revisao).strict();
