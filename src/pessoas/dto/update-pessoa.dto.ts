import { createZodDto } from 'nestjs-zod';
import { CreatePessoaSchema } from './create-pessoa.dto';

export class UpdatePessoaDto extends createZodDto(CreatePessoaSchema.partial()) {}
