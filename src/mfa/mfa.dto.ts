import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
export class MfaSetupDto extends createZodDto(z.object({ senha: z.string().min(1).max(255) }).strict()) {}
export class MfaActivateDto extends createZodDto(z.object({ codigo: z.string().regex(/^\d{6}$/) }).strict()) {}
export class MfaRecoveryDto extends createZodDto(z.object({ senha: z.string().min(1).max(255), codigo: z.string().max(24).optional() }).strict()) {}
export class MfaPolicyDto extends createZodDto(z.object({ senha: z.string().min(1).max(255), codigo: z.string().regex(/^\d{6}$/), obrigatorio: z.boolean() }).strict()) {}
export class MfaResumeDto extends createZodDto(z.object({ senha: z.string().min(1).max(255) }).strict()) {}
export class MfaConfirmRecoveryDto extends createZodDto(z.object({ codigo: z.string().regex(/^[a-f0-9]{24}$/i) }).strict()) {}
