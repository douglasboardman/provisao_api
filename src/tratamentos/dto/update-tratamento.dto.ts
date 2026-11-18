import { createZodDto } from 'nestjs-zod';
import { CreateTratamentoSchema } from './create-tratamento.dto';

export class UpdateTratamentoDto extends createZodDto(CreateTratamentoSchema.partial()) {}
