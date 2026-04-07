import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  vinculos_membresia_rol as VinculoRol,
  vinculos_membresia_forma_admissao as FormaAdmissao,
  vinculos_membresia_modalidade_exclusao as ModalidadeExclusao,
} from '@prisma/client';

export const CreateVinculosMembresiaSchema = z.object({
  pessoa_id: z.string().uuid("O campo 'pessoa_id' deve ser um UUID válido."),
  rol: z.nativeEnum(VinculoRol, { error: 'O rol informado é inválido.' }),
  data_admissao: z.coerce.date({ error: "O campo 'data_admissao' deve ser uma data válida." }),
  forma_admissao: z.nativeEnum(FormaAdmissao, { error: 'A forma de admissão informada é inválida.' }),
  igreja_origem: z.string().optional(),
  data_exclusao: z.coerce.date({ error: "O campo 'data_exclusao' deve ser uma data válida." }).optional(),
  modalidade_exclusao: z.nativeEnum(ModalidadeExclusao, { error: 'A modalidade de exclusão informada é inválida.' }).optional(),
  igreja_destino: z.string().optional(),
  vinculo_ativo: z.boolean().default(true),
});

export class CreateVinculosMembresiaDto extends createZodDto(CreateVinculosMembresiaSchema) {}
