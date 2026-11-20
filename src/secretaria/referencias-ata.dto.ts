import { z } from 'zod';

const texto = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.string().uuid();

export const alvoAtaSchema = z.object({
  grupo: z.enum(['MEMBRESIA', 'MANDATO', 'PASTORAL', 'ORGAO', 'FINANCEIRO']),
  alvo_id: uuid,
  etapa: z.enum(['ATO', 'ELEICAO', 'POSSE', 'INICIO', 'ENCERRAMENTO']),
});
export type ChaveAlvoAta = z.infer<typeof alvoAtaSchema>;

const externa = z
  .object({
    concilio: texto(255),
    identificacao: texto(255),
    data: z.iso.date(),
    localizacao: texto(1000),
    origem: texto(255).optional(),
    livro: texto(80).optional(),
    paginas: texto(80).optional(),
    conferida: z.literal(true),
  })
  .strict();

export const referenciaAta = z
  .object({
    ata_documento_id: uuid.optional(),
    versao_id: uuid.optional(),
    referencia_externa: externa.optional(),
    justificativa: texto(1000),
    revisao_esperada: uuid.nullable(),
  })
  .strict()
  .refine(
    (d) => Boolean(d.ata_documento_id) === Boolean(d.versao_id) && !(d.versao_id && d.referencia_externa),
    'Informe documento e versão da ata, ou uma referência externa conferida.',
  );
export type EntradaReferenciaAta = z.infer<typeof referenciaAta>;

export const paginaAta = z.coerce.number().int().min(0).max(10000).default(0);

export const buscaAta = z
  .object({
    pagina: paginaAta,
    contexto: uuid.optional(),
    numero: texto(100).optional(),
    data: z.iso.date().optional(),
  })
  .strict();

export const tiposFinanceiros = [
  'ORCAMENTO',
  'PRESTACAO_CONTAS',
  'DESPESA_EXTRAORDINARIA',
  'APROVACAO_PROJETO',
  'ENCERRAMENTO_PROJETO',
  'DESTINACAO_RECURSOS',
  'CONTA_SIGNATARIOS',
] as const;
export const autorizacaoFinanceira = z
  .object({
    idempotencia: uuid,
    projeto_id: uuid.optional(),
    conta_id: uuid.optional(),
    tipo: z.enum(tiposFinanceiros),
    assunto: texto(255),
    data_decisao: z.iso.date(),
    autoridade: texto(255),
    evidencia: texto(1000),
    decisao_ocorreu: z.literal(true),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.projeto_id && d.conta_id) ctx.addIssue({ code: 'custom', message: 'Selecione um projeto ou uma conta.' });
    if (['APROVACAO_PROJETO', 'ENCERRAMENTO_PROJETO'].includes(d.tipo) && !d.projeto_id)
      ctx.addIssue({ code: 'custom', message: 'Informe o projeto existente.' });
    if (d.tipo === 'CONTA_SIGNATARIOS' && !d.conta_id)
      ctx.addIssue({ code: 'custom', message: 'Informe a conta existente.' });
  });
