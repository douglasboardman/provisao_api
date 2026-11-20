import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class SalvarProfissaoDto extends createZodDto(z.object({
  nome: z.string().trim().min(1, 'Informe o nome da profissão.').max(120).transform(nome => nome.replace(/\s+/g, ' ')),
}).strict()) {}
