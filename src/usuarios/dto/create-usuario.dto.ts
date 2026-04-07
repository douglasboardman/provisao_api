import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { usuarios_perfil as Perfil } from '@prisma/client';

export const CreateUsuarioSchema = z.object({
  nome_usuario: z.string().min(1, 'O nome de usuário não pode estar vazio.'),
  email_login: z.string().email('O e-mail de login fornecido é inválido.'),
  url_imagem_perfil: z.string().url('O endereço da imagem do usuário não é uma URL válida.').optional(),
  senha: z.string().min(8, 'A senha deve ter no mínimo 8 (oito) caracteres.'),
  perfil: z.nativeEnum(Perfil, {
    error: 'O perfil fornecido é inválido.',
  }),
  ativo: z.boolean({ error: 'O campo "ativo" deve ser um booleano (true ou false).' }),
});

export class CreateUsuarioDto extends createZodDto(CreateUsuarioSchema) {}
