import { createZodDto } from 'nestjs-zod';
import { CreateDespesaSchema } from './create-despesa.dto';

export class UpdateDespesaDto extends createZodDto(CreateDespesaSchema.partial()) {}
