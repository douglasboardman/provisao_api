import { Module } from "@nestjs/common";
import { RegrasRelacaoEnumService } from "./regras-relacao-enum.service";
import { RegrasRelacaoEnumController } from "./regras-relacao-enum.controller";

@Module({
  controllers: [RegrasRelacaoEnumController],
  providers: [RegrasRelacaoEnumService],
  exports: [RegrasRelacaoEnumService],
})
export class RegrasRelacaoEnumModule {}
