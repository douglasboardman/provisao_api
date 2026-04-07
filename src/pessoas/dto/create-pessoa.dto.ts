import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { pessoas_sexo as Sexo, pessoas_estado_civil as EstadoCivil, estados_brasil as Estado } from '@prisma/client';
import { CpfSchema } from 'src/core/schemas/cpf.schema';

export const CreatePessoaSchema = z.object({
  nome_completo: z.string().min(1, 'O nome da pessoa não pode estar vazio.'),
  url_foto: z.string().url('A URL da foto é inválida.').optional(),
  cpf: CpfSchema.optional(),
  data_nascimento: z.string().date('A data de nascimento precisa estar no formato de data (YYYY-MM-DD).'),
  sexo: z.nativeEnum(Sexo, { error: 'O sexo informado é inválido.' }),
  estado_civil: z.nativeEnum(EstadoCivil, { error: 'O estado civil informado é inválido.' }).optional(),
  email: z.string().email('O email informado é inválido.').optional(),
  telefone_celular: z.string().optional(),
  cep: z.string().optional(),
  logradouro: z.string().optional(),
  numero: z.string().optional(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
  cidade: z.string().optional(),
  estado: z.nativeEnum(Estado, { error: 'O estado informado é inválido.' }).optional(),
  grupo_familiar_id: z.string().uuid('O grupo familiar precisa ser um UUID válido.').optional(),
});

export class CreatePessoaDto extends createZodDto(CreatePessoaSchema) {}
