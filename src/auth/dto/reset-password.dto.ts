import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'O token é obrigatório.'),
  nova_senha: z.string().min(8, 'A nova senha deve ter no mínimo 8 caracteres.'),
});

export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}

export class AlterarSenhaDto extends createZodDto(z.object({
  senha_atual: z.string().min(1).max(1024),
  nova_senha: ResetPasswordSchema.shape.nova_senha.refine(s => Buffer.byteLength(s, 'utf8') <= 72, 'A senha excede o limite de 72 bytes.'),
})) {}
