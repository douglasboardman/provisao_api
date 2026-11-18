import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateTratamentoSchema = z.object({
  descricao: z.string().min(1, 'A descrição do tratamento não pode ser vazia.'),
  abreviacao: z.string().min(1, 'A abreviação não pode ser vazia.'),
});

export class CreateTratamentoDto extends createZodDto(CreateTratamentoSchema) {}
