import { Module } from '@nestjs/common';
import { TratamentosService } from './tratamentos.service';
import { TratamentosController } from './tratamentos.controller';

@Module({
  controllers: [TratamentosController],
  providers: [TratamentosService],
})
export class TratamentosModule {}
