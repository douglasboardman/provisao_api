import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateAcoeSchema = z.object({
  nome: z.string().min(1, "O campo 'nome' não pode estar vazio."),
  descricao_detalhada: z.string().optional(),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
  responsavel_pessoa_id: z.string().uuid("O campo 'responsavel_pessoa_id' deve ser um UUID válido."),
  conta_id: z.string().uuid("O campo 'conta_id' deve ser um UUID válido."),
  data_inicio: z.coerce.date({ error: "O campo 'data_inicio' deve ser uma data válida." }),
  data_fim: z.coerce.date({ error: "O campo 'data_fim' deve ser uma data válida." }).optional(),
  orcamento_receita: z.number().nonnegative("O campo 'orcamento_receita' não pode ser negativo."),
  orcamento_despesa: z.number().nonnegative("O campo 'orcamento_despesa' não pode ser negativo."),
});

export class CreateAcoeDto extends createZodDto(CreateAcoeSchema) {}
