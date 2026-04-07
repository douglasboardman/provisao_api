import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'O token é obrigatório.'),
  nova_senha: z.string().min(8, 'A nova senha deve ter no mínimo 8 caracteres.'),
});

export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
