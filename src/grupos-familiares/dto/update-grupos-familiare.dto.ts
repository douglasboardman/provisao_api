import { createZodDto } from 'nestjs-zod';
import { CreateGruposFamiliareSchema } from './create-grupos-familiare.dto';

export class UpdateGruposFamiliareDto extends createZodDto(CreateGruposFamiliareSchema.partial()) {}
