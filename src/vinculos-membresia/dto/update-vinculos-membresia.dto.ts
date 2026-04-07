import { createZodDto } from 'nestjs-zod';
import { CreateVinculosMembresiaSchema } from './create-vinculos-membresia.dto';

export class UpdateVinculosMembresiaDto extends createZodDto(CreateVinculosMembresiaSchema.partial()) {}
