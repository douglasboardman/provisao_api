import { PastoresService } from './pastores.service';
import { PastoresController } from './pastores.controller';
import { PresidenciaService } from '../orgaos/presidencia.service';
import { RevisaoEleitoralService } from './revisao-eleitoral.service';
import { InsercaoRetroativaOficialService } from './insercao-retroativa-oficial.service';
import { CorrecaoConteudoService } from './correcao-conteudo.service';
import { InsercaoRetroativaService } from './insercao-retroativa.service';
import { Module } from '@nestjs/common';
import { ElegibilidadeModule } from '../elegibilidade/elegibilidade.module';
import { NotificacoesMandatoService } from './notificacoes-mandato.service';
import { IdentidadePastoralService } from './identidade-pastoral.service';
import { OrdenacaoMembresiaService } from './ordenacao-membresia.service';
import { CorrecaoMembresiaService } from './correcao-membresia.service';
import { AcervoHistoricoService } from './acervo-historico.service';
import { AcessoSensivelService } from './acesso-sensivel.service';
import { OficiaisController } from './oficiais.controller';
import { GovernancaGuard } from './governanca.guard';
import { SituacaoExercicioService } from './situacao-exercicio.service';
import { ImpactoRetroativoService } from './impacto-retroativo.service';
import { AlertasOficiaisService } from './alertas.service';
import { MandatoService } from './mandato.service';
import { OficiaisService } from './oficiais.service';
import { AtasEleitoraisService } from './atas-eleitorais.service';
import { SecretariaModule } from '../secretaria/secretaria.module';

@Module({ imports: [ElegibilidadeModule, SecretariaModule], controllers: [OficiaisController, PastoresController], providers: [PastoresService, PresidenciaService, RevisaoEleitoralService, InsercaoRetroativaOficialService, CorrecaoConteudoService, InsercaoRetroativaService, OrdenacaoMembresiaService, NotificacoesMandatoService, IdentidadePastoralService, CorrecaoMembresiaService, AcervoHistoricoService, AcessoSensivelService, GovernancaGuard, OficiaisService, MandatoService, AtasEleitoraisService, AlertasOficiaisService, ImpactoRetroativoService, SituacaoExercicioService], exports: [AtasEleitoraisService, NotificacoesMandatoService, OficiaisService, MandatoService, AlertasOficiaisService, ImpactoRetroativoService, SituacaoExercicioService, CorrecaoMembresiaService, CorrecaoConteudoService, InsercaoRetroativaService, OrdenacaoMembresiaService] })
export class OficiaisModule {}
