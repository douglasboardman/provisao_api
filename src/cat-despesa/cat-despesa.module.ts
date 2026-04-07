import { Module } from '@nestjs/common';
import { CatDespesaService } from './cat-despesa.service';
import { CatDespesaController } from './cat-despesa.controller';

@Module({
  controllers: [CatDespesaController],
  providers: [CatDespesaService],
})
export class CatDespesaModule {}
