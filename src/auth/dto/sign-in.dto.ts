import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const SignInSchema = z.object({
  login: z.string().trim().email('Informe um e-mail válido.'),
  igreja_id: z.string().uuid('Selecione uma igreja.'),
  senha: z.string().min(1, 'O campo senha não pode estar vazio.'),
  mfa_code: z.string().max(24).optional(),
});

export class SignInDto extends createZodDto(SignInSchema) {}
