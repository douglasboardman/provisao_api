import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateCatDespesaSchema = z.object({
  nome: z.string().min(1, 'O nome da categoria de despesa não pode ser vazio.'),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
});

export class CreateCatDespesaDto extends createZodDto(CreateCatDespesaSchema) {}
