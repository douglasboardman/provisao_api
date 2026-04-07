import { createZodDto } from 'nestjs-zod';
import { CreateReceitaSchema } from './create-receita.dto';

export class UpdateReceitaDto extends createZodDto(CreateReceitaSchema.partial()) {}
