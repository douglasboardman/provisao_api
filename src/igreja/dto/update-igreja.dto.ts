import { createZodDto } from 'nestjs-zod';
import { CreateIgrejaSchema } from './create-igreja.dto';

export class UpdateIgrejaDto extends createZodDto(
  CreateIgrejaSchema.omit({ congregacao: true, vinculada_a: true }).partial(),
) {}
