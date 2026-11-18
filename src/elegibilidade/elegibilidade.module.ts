import { Module } from '@nestjs/common';
import { PoliticaEleicaoService } from './politica-eleicao.service';
import { ConferenciaEleicaoService } from './conferencia-eleicao.service';
import { ElegibilidadeService } from './elegibilidade.service';

@Module({ providers: [ElegibilidadeService, ConferenciaEleicaoService, PoliticaEleicaoService], exports: [ElegibilidadeService, ConferenciaEleicaoService, PoliticaEleicaoService] })
export class ElegibilidadeModule {}
