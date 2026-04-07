import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const RegisterSchema = z.object({
  nome_usuario: z.string().min(3, 'O nome de usuário deve ter no mínimo 3 caracteres.'),
  email_login: z.string().email('O e-mail informado é inválido.'),
  igreja_id: z.string().uuid('O ID da igreja deve ser um UUID válido.'),
});

export class RegisterDto extends createZodDto(RegisterSchema) {}
