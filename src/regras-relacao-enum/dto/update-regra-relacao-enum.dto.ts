import { createZodDto } from "nestjs-zod";
import { CreateRegraRelacaoEnumSchema } from "./create-regra-relacao-enum.dto";

export class UpdateRegraRelacaoEnumDto extends createZodDto(
  CreateRegraRelacaoEnumSchema.partial(),
) {}
