import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  membresia_tipo_evento as TipoEvento,
  membresia_rol as MembresiaRol,
  membresia_motivacao_evento as MotivacaoEvento,
} from '@prisma/client';

export const CreateEventoMembresiaSchema = z.object({
  pessoa_id: z.string().uuid("O campo 'pessoa_id' deve ser um UUID válido."),
  tipo_evento: z.nativeEnum(TipoEvento, {
    error: 'O tipo de evento informado é inválido.',
  }),
  rol: z.nativeEnum(MembresiaRol, {
    error: 'O rol informado é inválido.',
  }),
  rol_origem: z.nativeEnum(MembresiaRol).optional(),
  motivacao_evento: z.nativeEnum(MotivacaoEvento, {
    error: 'A motivação informada é inválida.',
  }),
  data_evento: z.union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: "O campo 'data_evento' deve ser uma data válida.",
  }).transform(data => new Date(data.slice(0, 10))),
  ordem_dia: z.number().int().min(1).max(9999).optional(),
  igreja_origem: z.string().max(255).optional(),
  igreja_destino: z.string().max(255).optional(),
  referencia_documental: z.string({ error: 'Identifique o documento que comprova a movimentação.' })
    .trim().min(1, 'Identifique o documento que comprova a movimentação.').max(1000),
  observacoes: z.string().optional(),
});

export class CreateEventoMembresiaDto extends createZodDto(
  CreateEventoMembresiaSchema,
) {}
