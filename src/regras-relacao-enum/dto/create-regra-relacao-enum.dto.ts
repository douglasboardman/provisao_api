import { z } from "zod";
import { createZodDto } from "nestjs-zod";
import { tipo_regra_enum } from "@prisma/client";

export const CreateRegraRelacaoEnumSchema = z.object({
  modulo: z.string().min(1).max(100),
  nome: z.string().min(1).max(255),
  descricao: z.string().optional(),
  tipo_regra: z.nativeEnum(tipo_regra_enum),
  enum_classificador: z.string().min(1).max(100),
  enum_classificado: z.string().min(1).max(100),
});

export class CreateRegraRelacaoEnumDto extends createZodDto(
  CreateRegraRelacaoEnumSchema,
) {}

export const ReplaceValoresSchema = z.object({
  valores: z.array(
    z.object({
      valor_classificador: z.string().min(1).max(100),
      valor_classificado: z.string().min(1).max(100),
    }),
  ),
});

export class ReplaceValoresDto extends createZodDto(ReplaceValoresSchema) {}
