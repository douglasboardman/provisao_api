import { z } from 'zod';
import { Cpf } from '../classes/cpf.class';

export const CpfSchema = z
  .string()
  .refine((value) => Cpf.isValid(value), {
    message: 'O CPF fornecido é inválido.',
  });
