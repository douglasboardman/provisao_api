import { Module } from '@nestjs/common';
import { CatReceitaService } from './cat-receita.service';
import { CatReceitaController } from './cat-receita.controller';

@Module({
  controllers: [CatReceitaController],
  providers: [CatReceitaService],
})
export class CatReceitaModule {}
