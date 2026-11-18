import { resolucao_resultado } from '@prisma/client';
import { z } from 'zod';

export const resultadosResolucao = {
  APROVADA: 'Aprovada',
  APROVADA_COM_ALTERACOES: 'Aprovada com alterações',
  REJEITADA: 'Rejeitada',
  RETIRADA: 'Retirada',
  ADIADA: 'Adiada',
} satisfies Record<resolucao_resultado, string>;

const quantidade = z.number().int().min(0).max(1000000);
const apuracao = z
  .object({
    favoraveis: quantidade.optional(),
    contrarios: quantidade.optional(),
    abstencoes: quantidade.optional(),
    impedimentos: quantidade.optional(),
    quorum: quantidade.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Informe algum dado da apuração ou deixe-a vazia.');

const pessoas = z
  .array(z.uuid().transform((id) => id.toLowerCase()))
  .max(1000)
  .default([])
  .refine((ids) => ids.length === new Set(ids).size, 'Pessoa repetida na mesma relação.');
const teor = z.string().trim().min(1).max(20000).nullable().default(null);

const resolucaoSchema = z
  .object({
    ordem: z.number().int().min(1).max(1000000),
    assunto: z.string().trim().min(1).max(255),
    texto_proposta: teor,
    texto_deliberado: teor,
    resultado: z.enum(resolucao_resultado),
    eficaz: z.boolean().default(false),
    data_efeito: z.iso.date().nullable().default(null),
    votacao_secreta: z.boolean().default(false),
    apuracao: apuracao.nullable().default(null),
    proponentes_pessoas_ids: pessoas,
    dissidentes_pessoas_ids: pessoas,
  })
  .strict()
  .superRefine((r, ctx) => {
    const erro = (campo: keyof typeof r, message: string) => ctx.addIssue({ code: 'custom', path: [campo], message });
    const aprovada = r.resultado === 'APROVADA' || r.resultado === 'APROVADA_COM_ALTERACOES';
    if (!r.texto_proposta && !r.texto_deliberado)
      erro('texto_proposta', 'Registre o texto da proposta ou da deliberação.');
    if (aprovada && !r.texto_deliberado) erro('texto_deliberado', 'Resultado aprovado exige texto deliberado.');
    if (r.resultado === 'APROVADA_COM_ALTERACOES' && (!r.texto_proposta || r.texto_proposta === r.texto_deliberado)) {
      erro('texto_proposta', 'Preserve o texto original e a redação final alterada.');
    }
    if (!aprovada && r.eficaz) erro('eficaz', 'Somente resolução aprovada pode ter eficácia.');
    if (!r.eficaz && r.data_efeito) erro('data_efeito', 'Data de efeito exige eficácia registrada.');
    if (r.votacao_secreta && r.dissidentes_pessoas_ids.length)
      erro('dissidentes_pessoas_ids', 'Votação secreta admite apenas apuração agregada.');
  });

export const resolucoesSchema = z
  .array(resolucaoSchema)
  .max(100)
  .refine((rs) => new Set(rs.map((r) => r.ordem)).size === rs.length, 'A ordem da resolução deve ser única na versão.')
  .refine((rs) => JSON.stringify(rs).length <= 200000, 'As resoluções excedem o limite de conteúdo da versão.');

export type ResolucaoInput = z.infer<typeof resolucoesSchema>[number];

export const filtrosAtuacaoSchema = z
  .object({
    tipo: z.enum(['resolucoes', 'registros']).default('resolucoes'),
    contexto: z.uuid().optional(),
    pessoa: z.uuid().optional(),
    de: z.iso.date().optional(),
    ate: z.iso.date().optional(),
    assunto: z.string().trim().min(1).max(255).optional(),
    resultado: z.enum(resolucao_resultado).optional(),
  })
  .strict()
  .refine((f) => !f.de || !f.ate || f.de <= f.ate, 'Informe um período válido.');
export const consultaAtuacaoSchema = z
  .object({
    ...filtrosAtuacaoSchema.shape,
    pagina: z
      .string()
      .regex(/^[0-9]{1,6}$/)
      .transform(Number)
      .default(0),
  })
  .strict()
  .refine((f) => !f.de || !f.ate || f.de <= f.ate, 'Informe um período válido.');
