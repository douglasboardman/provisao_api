import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const ForgotPasswordSchema = z.object({
  email_login: z.string().email('O e-mail informado é inválido.'),
});

export class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}
