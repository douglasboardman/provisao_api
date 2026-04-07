import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateGruposFamiliareSchema = z.object({
  nome_familia: z.string().min(1, 'O nome da família não pode ser vazio.'),
});

export class CreateGruposFamiliareDto extends createZodDto(CreateGruposFamiliareSchema) {}
