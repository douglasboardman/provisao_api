import { Module } from '@nestjs/common';
import { ProfissoesController } from './profissoes.controller';
import { ProfissoesService } from './profissoes.service';

@Module({ controllers: [ProfissoesController], providers: [ProfissoesService] })
export class ProfissoesModule {}
