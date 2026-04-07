import { createZodDto } from 'nestjs-zod';
import { CreateUsuarioSchema } from './create-usuario.dto';

export class UpdateUsuarioDto extends createZodDto(CreateUsuarioSchema.partial()) {}
