import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateReceitaSchema = z.object({
  nome: z.string().min(1, 'O campo nome não pode ser nulo.'),
  cat_receita_id: z.number().int().positive('O campo cat_receita_id deve ser um número inteiro positivo.'),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
  requer_pessoa: z.boolean(),
  requer_acao: z.boolean(),
  requer_conta: z.boolean(),
  requer_comprovante: z.boolean(),
});

export class CreateReceitaDto extends createZodDto(CreateReceitaSchema) {}
