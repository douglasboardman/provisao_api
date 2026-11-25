import { VersoesInstitucionaisController } from './versoes-institucionais.controller';
import { VersoesInstitucionaisService } from './versoes-institucionais.service';
import { SociedadesMinisteriosService } from './sociedades-ministerios.service';
import { SociedadesMinisteriosController } from './sociedades-ministerios.controller';
import { SecretariaModule } from '../secretaria/secretaria.module';
import { MandatoDiretoService } from './mandato-direto.service';
import { ManutencaoOrgaoService } from './manutencao-orgao.service';
import { Module } from '@nestjs/common';
import { ComposicaoService } from './composicao.service';
import { OrgaosController } from './orgaos.controller';
import { OrgaosGuard } from './orgaos.guard';
import { OrgaosGestaoGuard } from './orgaos-gestao.guard';
import { OrgaosGestaoController } from './orgaos-gestao.controller';
import { OrgaosOficiaisService } from './orgaos-oficiais.service';
import { UnidadesService } from './unidades.service';
import { PresidenciaService } from './presidencia.service';
import { ConfiguracaoCargosService } from './configuracao-cargos.service';
import { PoliticaUnidadeService } from './politica-unidade.service';
import { ParticipacaoService } from './participacao.service';
import { DesignacoesService } from './designacoes.service';
import { CargosEleitosService } from './cargos-eleitos.service';
import { CargosUnidadeEleitaService } from './cargos-unidade-eleita.service';
import { DesativacaoOrgaoService } from './desativacao-orgao.service';
import { FusoIgrejaService } from './fuso-igreja.service';
import { DecisaoRevisaoOrgaoService } from './decisao-revisao-orgao.service';
import { OficiaisModule } from '../oficiais/oficiais.module';

/** Escrita fechada independentemente da consulta até concluir a homologação. */
@Module({ imports: [OficiaisModule, SecretariaModule], controllers: [SociedadesMinisteriosController, OrgaosGestaoController, VersoesInstitucionaisController, OrgaosController], providers: [VersoesInstitucionaisService, SociedadesMinisteriosService, MandatoDiretoService, ManutencaoOrgaoService, ComposicaoService, OrgaosGuard, OrgaosGestaoGuard, OrgaosOficiaisService, UnidadesService, PresidenciaService, ConfiguracaoCargosService, PoliticaUnidadeService, ParticipacaoService, DesignacoesService, CargosEleitosService, CargosUnidadeEleitaService, DesativacaoOrgaoService, FusoIgrejaService, DecisaoRevisaoOrgaoService] })
export class OrgaosModule {}
