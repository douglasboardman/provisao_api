import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { resolucoesSchema } from './resolucoes.dto';

export const dia = z.iso.date();
export const texto = z.string().trim().min(1).max(1000);
export const nome = z.string().trim().min(1).max(255);
export const codigo = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
export const chave = { idempotencia: z.uuid() };
export const revisao = { revisao: z.number().int().positive() };
export const contextoSchema = z.object({ ...chave, tipo: z.enum(['ORGAO', 'ASSEMBLEIA_GERAL']), orgao_id: z.uuid().optional(), nome, sigla: z.string().trim().regex(/^[A-Z0-9-]{1,40}$/) }).strict();
export const competenciaSchema = z.object({ ...chave, contexto_id: z.uuid(), usuario_id: z.uuid(), inicio: dia, fim: dia.nullable().default(null), pode_aprovar: z.boolean(), pode_deliberar: z.boolean(), pode_consultar_restritos: z.boolean(), autoridade: nome, evidencia: texto }).strict().refine(v => !v.fim || v.fim > v.inicio, 'Período inválido.');
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
export const configuracaoSchema = z.object({
  perfil: codigo, contexto: z.enum(['ORGAO', 'ASSEMBLEIA_GERAL']),
  tipos_orgao: z.array(z.enum(['CONSELHO', 'JUNTA', 'UNIDADE_MINISTERIAL'])).max(3).default([]),
  constituicoes: z.array(z.enum(['OFICIAL', 'ELEICAO', 'DESIGNACAO'])).max(3).default([]),
  motivador: politica, resolucoes: politica, registro_livro: z.boolean().default(false), registro_em_livro: politica.optional(),
  campos_obrigatorios: z.array(codigo).max(50), papeis_obrigatorios: z.array(codigo).max(30),
  cargos_obrigatorios: z.array(z.uuid()).max(30),
  tipos_campos: z.record(codigo, tipoCampo).refine(v => Object.keys(v).length <= 50, 'Até 50 campos tipados.').optional(),
  estrutura_padrao: estruturaSchema.optional(),
}).strict();
const modelo = { tipo: z.enum(['ATA', 'OUTRO']), finalidade: codigo, configuracao: configuracaoSchema };
export const modeloSchema = z.object({ ...chave, contexto_id: z.uuid(), nome, ...modelo }).strict();
export const modeloVersaoSchema = z.object({ ...chave, ...revisao, ...modelo }).strict();
const participante = z.object({ pessoa_id: z.uuid(), presente: z.boolean(), papeis: z.array(codigo).min(1).max(20), pode_propor: z.boolean().optional() }).strict();
export const modalidadeReuniaoSchema = z.enum(['ORDINARIA', 'EXTRAORDINARIA', 'REGULAR', 'AGO', 'AGE']);
export const reuniaoDadosSchema = z.object({
  restrito: z.boolean(), modalidade: modalidadeReuniaoSchema, data: dia,
  local: nome, inicio: z.iso.datetime({ offset: true }).nullable().default(null), fim: z.iso.datetime({ offset: true }).nullable().default(null),
  pauta: z.string().trim().min(1).max(20000), competencia: texto,
  universo_informado: z.number().int().nonnegative().max(1000000), quorum_minimo: z.number().int().nonnegative().max(1000000),
  quorum_conferido: z.boolean(), fundamento_quorum: texto,
  resultado: z.string().trim().max(20000), participantes: z.array(participante).max(1000),
}).strict().refine(v => v.quorum_minimo <= v.universo_informado, 'Quórum maior que universo.').refine(v => !v.inicio || !v.fim || new Date(v.fim) >= new Date(v.inicio), 'Horários inválidos.');
export const reuniaoSchema = z.object({ ...chave, contexto_id: z.uuid(), dados: reuniaoDadosSchema }).strict();
export const editarReuniaoSchema = z.object({ ...chave, ...revisao, dados: reuniaoDadosSchema }).strict();
const arrolado = z.object({ pessoa_id: z.uuid(), papeis: z.array(codigo).min(1).max(30), cargo_id: z.uuid().nullable().default(null), cargos_ids: z.array(z.uuid()).max(30).default([]), assina: z.boolean(), obrigatorio: z.boolean(), responsavel: z.boolean(), fundamento: z.string().trim().max(1000) }).strict().refine(v => !v.obrigatorio || v.assina, 'Obrigatório deve assinar.');
export const conteudoSchema = z.object({
  teor: z.string().max(200000), campos: z.record(codigo, z.string().max(10000)).refine(v => Object.values(v).reduce((s, t) => s + t.length, 0) <= 60000 && Object.keys(v).length <= 100, 'Campos excedem o limite permitido.'),
  arrolados: z.array(arrolado).max(1000), anexos: z.array(z.object({ arquivo_id: z.uuid(), nome }).strict()).max(50),
  estrutura: estruturaSchema.optional(),
}).strict();
export const versaoSchema = z.object({ modelo_versao_id: z.uuid(), livro_id: z.uuid().nullable().optional(), reuniao_id: z.uuid().nullable().default(null), motivador_id: z.uuid().nullable().default(null), assunto: nome, data_documento: dia, conteudo: conteudoSchema, resolucoes: resolucoesSchema.optional() }).strict();
export const documentoSchema = z.object({ ...chave, contexto_id: z.uuid(), restrito: z.boolean(), versao: versaoSchema }).strict();
export const editarDocumentoSchema = z.object({ ...chave, ...revisao, versao: versaoSchema }).strict();
export const comandoSchema = z.object({ ...chave, ...revisao, autoridade: nome, evidencia: texto }).strict();
export const modalidadeAssinatura = z.enum(['ELETRONICA', 'FISICA']);
export const aprovacaoSchema = comandoSchema.extend({ modalidade: modalidadeAssinatura.optional() }).strict();
export const deliberacaoSchema = comandoSchema.extend({ reuniao_id: z.uuid(), resultado: z.enum(['APROVADA', 'REJEITADA', 'ADIADA']), data: dia }).strict();
export const retificarSchema = comandoSchema.extend({ versao: versaoSchema }).strict();
export function validar<T extends z.ZodType>(schema: T, dados: unknown): z.infer<T> {
  const v = schema.safeParse(dados);
  if (!v.success) throw new BadRequestException(v.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return v.data;
}
export type ConfiguracaoModelo = z.infer<typeof configuracaoSchema>;
export type VersaoInput = z.infer<typeof versaoSchema>;
export type ReuniaoInput = z.infer<typeof reuniaoDadosSchema>;

export function imagensDaEstrutura(estrutura?: VersaoInput['conteudo']['estrutura']) {
  return Object.values(estrutura ?? {}).flat().filter(bloco => bloco.tipo === 'IMAGEM');
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
