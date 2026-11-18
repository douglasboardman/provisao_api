import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
const schema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export class ConfirmAccessDto extends createZodDto(schema) {}
