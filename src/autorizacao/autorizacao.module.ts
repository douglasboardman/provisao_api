import { LiberacoesService } from './liberacoes.service';
import { DiscoveryModule } from '@nestjs/core';
import { RotasServicosService } from './rotas-servicos.service';
import { Module } from '@nestjs/common';
import { SecretariaModule } from '../secretaria/secretaria.module';
import { AutorizacaoController } from './autorizacao.controller';
import { ContasAutorizacaoService } from './contas.service';

@Module({ imports: [SecretariaModule, DiscoveryModule], controllers: [AutorizacaoController], providers: [ContasAutorizacaoService, RotasServicosService, LiberacoesService] })
export class AutorizacaoModule {}
