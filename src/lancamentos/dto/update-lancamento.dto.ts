import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { lancamentos_tipo_transacao as TipoTransacao } from '@prisma/client';

const UpdateLancamentoSchema = z.object({
  data_transacao: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  valor: z.number().positive().optional(),
  tipo_transacao: z.nativeEnum(TipoTransacao).optional(),
  conta_id: z.string().uuid().optional(),
  acao_id: z.string().uuid().optional().nullable(),
  receita_id: z.number().int().positive().optional().nullable(),
  despesa_id: z.number().int().positive().optional().nullable(),
  pessoa_id: z.string().uuid().optional().nullable(),
  observacao: z.string().max(1000).optional().nullable(),
  comprovante_url: z.string().url().max(255).optional().nullable(),
});

export class UpdateLancamentoDto extends createZodDto(UpdateLancamentoSchema) {}
