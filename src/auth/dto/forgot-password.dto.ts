import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const ForgotPasswordSchema = z.object({
  email_login: z.string().trim().email('O e-mail informado é inválido.'),
  igreja_id: z.string().uuid('Selecione uma igreja.'),
});

export class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}
