import { Module } from '@nestjs/common';
import { PessoasService } from './pessoas.service';
import { PessoasController } from './pessoas.controller';
import { StorageModule } from 'src/storage/storage.module';
import { GruposFamiliaresService } from 'src/grupos-familiares/grupos-familiares.service';

@Module({
  imports: [StorageModule],
  controllers: [PessoasController],
  providers: [PessoasService, GruposFamiliaresService],
})
export class PessoasModule {}
