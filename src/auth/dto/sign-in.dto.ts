import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const SignInSchema = z.object({
  login: z.string().min(1, 'O campo login não pode estar vazio.'),
  senha: z.string().min(1, 'O campo senha não pode estar vazio.'),
});

export class SignInDto extends createZodDto(SignInSchema) {}
