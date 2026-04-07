import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateCatReceitaSchema = z.object({
  nome: z.string().min(1, 'O nome da categoria de receita não pode ser vazio.'),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
});

export class CreateCatReceitaDto extends createZodDto(CreateCatReceitaSchema) {}
