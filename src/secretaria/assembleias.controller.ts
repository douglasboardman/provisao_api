import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { OperacaoContextual, SecretariaGuard } from './secretaria.guard';
import type { AtorSecretaria } from './secretaria-base.service';
import { AssembleiasService } from './assembleias.service';

@Controller('secretaria/reunioes/:id/assembleia')
@UseGuards(AuthGuard, RolesGuard, SecretariaGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
export class AssembleiasController {
  constructor(private readonly assembleias: AssembleiasService) {}

  @OperacaoContextual()
  @Get() @Header('Cache-Control','private, no-store')
  ficha(@Request() req: { user: AtorSecretaria }, @Param('id', ParseUUIDPipe) id: string) { return this.assembleias.ficha(req.user,id); }

  @OperacaoContextual()
  @Get('rol') @Header('Cache-Control','private, no-store')
  rol(@Request() req: { user: AtorSecretaria }, @Param('id', ParseUUIDPipe) id: string, @Query('referencia') dia: string) {
    return this.assembleias.previa(req.user,id,dia);
  }

  @OperacaoContextual()
  @Get('folhas/:folha') @Header('Cache-Control','private, no-store')
  folha(@Request() req: { user: AtorSecretaria }, @Param('id', ParseUUIDPipe) id: string, @Param('folha', ParseUUIDPipe) folha: string) {
    return this.assembleias.folha(req.user,id,folha);
  }

  @OperacaoContextual()
  @Post('folhas')
  gerar(@Request() req: { user: AtorSecretaria }, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.assembleias.gerar(req.user,id,dados);
  }

  @OperacaoContextual()
  @Post('mesa')
  instalar(@Request() req: { user: AtorSecretaria }, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.assembleias.instalar(req.user,id,dados);
  }
}
