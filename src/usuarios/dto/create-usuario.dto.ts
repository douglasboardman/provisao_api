import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { usuarios_perfil as Perfil } from '@prisma/client';

export const CreateUsuarioSchema = z.object({
  nome_usuario: z.string().min(1, 'O nome de usuário não pode estar vazio.'),
  email_login: z.string().trim().email('O e-mail de login fornecido é inválido.'),
  url_imagem_perfil: z.string().url().optional(),
  perfil: z.nativeEnum(Perfil),
}).strict();
export class CreateUsuarioDto extends createZodDto(CreateUsuarioSchema) {}
