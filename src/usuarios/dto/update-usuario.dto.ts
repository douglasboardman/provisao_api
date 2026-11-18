import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { usuarios_perfil as Perfil } from '@prisma/client';

const UpdateUsuarioSchema = z.object({
  nome_usuario: z.string().min(1).optional(),
  email_login: z.string().trim().email().optional(),
  url_imagem_perfil: z.string().optional(),
  perfil: z.nativeEnum(Perfil).optional(),
  ativo: z.boolean().optional(),
}).strict();
export class UpdateUsuarioDto extends createZodDto(UpdateUsuarioSchema) {}
