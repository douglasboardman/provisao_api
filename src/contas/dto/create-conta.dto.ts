import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { tipo_conta as TipoConta } from '@prisma/client';

export const CreateContaSchema = z.object({
  descricao: z.string().min(1, "O campo 'descricao' não pode estar vazio."),
  banco: z.string().optional(),
  tipo_conta: z.nativeEnum(TipoConta, {
    error: "O campo 'tipo_conta' deve ser um valor válido de tipo_conta.",
  }),
  num_conta: z.string().optional(),
  agencia: z.string().optional(),
  saldo_inicial: z.number().nonnegative("O campo 'saldo_inicial' não pode ser negativo."),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
});

export class CreateContaDto extends createZodDto(CreateContaSchema) {}
