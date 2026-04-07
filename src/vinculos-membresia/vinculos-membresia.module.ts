import { Module } from '@nestjs/common';
import { VinculosMembresiaService } from './vinculos-membresia.service';
import { VinculosMembresiaController } from './vinculos-membresia.controller';

@Module({
  controllers: [VinculosMembresiaController],
  providers: [VinculosMembresiaService],
})
export class VinculosMembresiaModule {}
