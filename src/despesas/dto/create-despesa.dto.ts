import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateDespesaSchema = z.object({
  nome: z.string().min(1, 'O campo nome não pode ser nulo.'),
  cat_despesa_id: z.number().int().positive('O campo cat_despesa_id deve ser um número inteiro positivo.'),
  requer_pessoa: z.boolean(),
  requer_acao: z.boolean(),
  requer_conta: z.boolean(),
  requer_comprovante: z.boolean(),
});

export class CreateDespesaDto extends createZodDto(CreateDespesaSchema) {}
