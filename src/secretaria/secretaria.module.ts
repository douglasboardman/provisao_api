import { MinhaAssembleiaController, PresidenciaAssembleiaController } from './minha-assembleia.controller';
import { MinhaAssembleiaService } from './minha-assembleia.service';
import { AcessoAssembleiaService } from './acesso-assembleia.service';
import { AssembleiasController } from "./assembleias.controller";
import { AssembleiasService } from "./assembleias.service";
import { AtuacaoModeloService } from './atuacao-modelo.service';
import { PerfilController } from './perfil.controller';
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

@Module({ imports: [PrivateStorageModule], controllers: [MinhaAssembleiaController, PresidenciaAssembleiaController, AssembleiasController, PerfilController, ReferenciasAtaController, SecretariaController, LivrosController, AssinaturasController, PortalAssinaturasController], providers: [MinhaAssembleiaService, AcessoAssembleiaService, AssembleiasService, AtuacaoModeloService, ReferenciasAtaService, SecretariaGuard, SecretariaBaseService, SecretariaCadastrosService, DocumentosService, AtasLegadasService, ComposicaoService, AssinaturasService, ExpedicaoArquivos, AtuacaoService, RascunhosService, LivrosService, ExpedicaoWorkerService], exports: [AtuacaoModeloService, ComposicaoService, SecretariaBaseService, RascunhosService, LivrosService, ExpedicaoWorkerService] })
export class SecretariaModule {}
