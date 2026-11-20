import { z } from 'zod';
import { resolucoesSchema } from './resolucoes.dto';
import { codigo } from './secretaria.dto';

const texto = (max: number) => z.string().trim().min(1).max(max);
const conferencia = { idempotencia: z.uuid(), autoridade: texto(255), evidencia: texto(1000) };

export const ataLegadaSchema = z
  .object({
    ...conferencia,
    contexto_id: z.uuid(),
    restrito: z.boolean(),
    numero_original: texto(100).nullable(),
    assunto: texto(255),
    data_documento: z.iso.date(),
    reuniao_id: z.uuid().nullable().default(null),
    reuniao: z
      .object({
        data: z.iso.date().nullable(),
        local: texto(255).nullable(),
        modalidade: z.enum(['ORDINARIA', 'EXTRAORDINARIA', 'AGO', 'AGE']).nullable(),
        inicio: z.iso.datetime({ offset: true }).nullable(),
        fim: z.iso.datetime({ offset: true }).nullable(),
        pauta: texto(20000).nullable(),
      })
      .strict()
      .refine(
        (r) => !r.inicio || !r.fim || Date.parse(r.inicio) <= Date.parse(r.fim),
        'Horários da reunião inválidos.',
      ),
    pdf: z.object({ arquivo_id: z.uuid(), nome: texto(255) }).strict(),
    teor: texto(200000),
    arrolados: z
      .array(
        z
          .object({
            pessoa_id: z.uuid().transform((id) => id.toLowerCase()),
            papeis: z.array(codigo).min(1).max(30),
            fundamento: z.string().trim().max(1000).default(''),
          })
          .strict(),
      )
      .max(1000)
      .refine((a) => new Set(a.map((p) => p.pessoa_id)).size === a.length, 'Unifique os papéis da mesma pessoa.'),
    resolucoes: resolucoesSchema.default([]),
    conferida: z.literal(true),
  })
  .strict()
  .refine((v) => !v.reuniao.data || v.reuniao.data <= v.data_documento, 'A reunião deve ocorrer até a data da ata.');

export const teorAtaLegadaSchema = z.object({ contexto_id: z.uuid(), arquivo_id: z.uuid() }).strict();

export const livroAtaLegadaSchema = z
  .object({
    ...conferencia,
    revisao: z.number().int().positive(),
    livro_id: z.uuid().nullable(),
    folhas: texto(80).nullable(),
  })
  .strict()
  .refine((v) => v.livro_id || !v.folhas, 'Informe um livro para registrar as folhas originais.');
