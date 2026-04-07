import { createZodDto } from 'nestjs-zod';
import { CreateAcoeSchema } from './create-acoe.dto';

export class UpdateAcoeDto extends createZodDto(CreateAcoeSchema.partial()) {}
