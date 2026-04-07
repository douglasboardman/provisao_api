import { createZodDto } from 'nestjs-zod';
import { CreateContaSchema } from './create-conta.dto';

export class UpdateContaDto extends createZodDto(CreateContaSchema.partial()) {}
