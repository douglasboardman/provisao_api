import { Module } from '@nestjs/common';
import { PrivateStorageModule } from '../private-storage/private-storage.module';
import { ComposicaoService } from '../orgaos/composicao.service';
import { SecretariaBaseService } from './secretaria-base.service';
import { SecretariaCadastrosService } from './secretaria-cadastros.service';
import { SecretariaController } from './secretaria.controller';
import { SecretariaGuard } from './secretaria.guard';
import { DocumentosService } from './documentos.service';
import { LivrosService } from './livros.service';
import { LivrosController } from './livros.controller';
import { RascunhosService } from './rascunhos.service';
import { AssinaturasController, PortalAssinaturasController } from './assinaturas.controller';
import { AssinaturasService } from './assinaturas.service';
import { ExpedicaoArquivos } from './expedicao-arquivos';
import { AtuacaoService } from './atuacao.service';
import { ExpedicaoWorkerService } from './expedicao-worker.service';

import { ReferenciasAtaController } from './referencias-ata.controller';
import { ReferenciasAtaService } from './referencias-ata.service';
import { AtasLegadasService } from './atas-legadas.service';

@Module({ imports: [PrivateStorageModule], controllers: [ReferenciasAtaController, SecretariaController, LivrosController, AssinaturasController, PortalAssinaturasController], providers: [ReferenciasAtaService, SecretariaGuard, SecretariaBaseService, SecretariaCadastrosService, DocumentosService, AtasLegadasService, ComposicaoService, AssinaturasService, ExpedicaoArquivos, AtuacaoService, RascunhosService, LivrosService, ExpedicaoWorkerService], exports: [RascunhosService, LivrosService, ExpedicaoWorkerService] })
export class SecretariaModule {}
