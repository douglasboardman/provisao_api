import { createZodDto } from 'nestjs-zod';
import { CreateCatDespesaSchema } from './create-cat-despesa.dto';

export class UpdateCatDespesaDto extends createZodDto(CreateCatDespesaSchema.partial()) {}
