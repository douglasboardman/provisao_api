import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
const schema = z.object({ pessoa_id: z.string().uuid().nullable() }).strict();
export class VincularPessoaDto extends createZodDto(schema) {}
