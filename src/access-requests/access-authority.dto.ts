import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
const schema = z.object({ usuario_id: z.string().uuid(), referencia: z.string().trim().min(10).max(500) }).strict();
export class AccessAuthorityDto extends createZodDto(schema) {}
