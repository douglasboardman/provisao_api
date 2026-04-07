import { createZodDto } from 'nestjs-zod';
import { CreateCatReceitaSchema } from './create-cat-receita.dto';

export class UpdateCatReceitaDto extends createZodDto(CreateCatReceitaSchema.partial()) {}
