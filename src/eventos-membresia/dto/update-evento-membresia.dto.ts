import { createZodDto } from 'nestjs-zod';
import { CreateEventoMembresiaSchema } from './create-evento-membresia.dto';

export class UpdateEventoMembresiaDto extends createZodDto(
  CreateEventoMembresiaSchema.omit({ ordem_dia: true }).partial(),
) {}
