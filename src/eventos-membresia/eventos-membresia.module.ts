import { Module } from '@nestjs/common';
import { OrdenacaoMembresiaService } from '../oficiais/ordenacao-membresia.service';
import { GovernancaGuard } from '../oficiais/governanca.guard';
import { EventosMembresiaService } from './eventos-membresia.service';
import { EventosMembresiaController } from './eventos-membresia.controller';
import { RegrasRelacaoEnumModule } from 'src/regras-relacao-enum/regras-relacao-enum.module';

@Module({
  imports: [RegrasRelacaoEnumModule],
  controllers: [EventosMembresiaController],
  providers: [EventosMembresiaService, OrdenacaoMembresiaService, GovernancaGuard],
})
export class EventosMembresiaModule {}
