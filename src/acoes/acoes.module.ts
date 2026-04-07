import { Module } from '@nestjs/common';
import { AcoesService } from './acoes.service';
import { AcoesController } from './acoes.controller';

@Module({
  controllers: [AcoesController],
  providers: [AcoesService],
})
export class AcoesModule {}
