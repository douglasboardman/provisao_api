import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { estados_brasil } from '@prisma/client';

export const CreateIgrejaSchema = z.object({
  nome: z.string().min(1, 'O nome da igreja não pode estar vazio.'),
  cnpj: z
    .string()
    .length(14, 'O CNPJ deve conter exatamente 14 dígitos.')
    .regex(/^\d{14}$/, 'O CNPJ deve conter apenas dígitos numéricos.')
    .optional(),
  congregacao: z.boolean().default(false),
  vinculada_a: z.string().uuid('O campo vinculada_a deve ser um UUID válido.').optional(),
  cep: z
    .string()
    .length(8, 'O CEP deve conter exatamente 8 dígitos.')
    .regex(/^\d{8}$/, 'O CEP deve conter apenas dígitos numéricos.')
    .optional(),
  logradouro: z.string().optional(),
  numero: z.string().optional(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
  cidade: z.string().optional(),
  estado: z.nativeEnum(estados_brasil, { error: 'O estado informado é inválido.' }).optional(),
});

export class CreateIgrejaDto extends createZodDto(CreateIgrejaSchema) {}
