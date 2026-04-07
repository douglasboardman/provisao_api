import { Module } from '@nestjs/common';
import { GruposFamiliaresService } from './grupos-familiares.service';
import { GruposFamiliaresController } from './grupos-familiares.controller';

@Module({
  controllers: [GruposFamiliaresController],
  providers: [GruposFamiliaresService],
})
export class GruposFamiliaresModule {}
