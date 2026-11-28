import { Body, Controller, Get, Header, Post, Query, Request, UseGuards } from '@nestjs/common';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { ServicoDaRota } from '../autorizacao/politica';
import { GovernancaGuard } from './governanca.guard';
import { PastoresService } from './pastores.service';
@Controller('pastores')
@UseGuards(AuthGuard, RolesGuard, GovernancaGuard)
export class PastoresController {
  constructor(private readonly pastores: PastoresService) {}
  @Get()
  @Roles(Perfil.ADMINISTRADOR, Perfil.COMUM, Perfil.AUDITOR)
  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Header('Cache-Control', 'private, no-store')
  listar(@Request() req, @Query('data') data: string) { return this.pastores.listar(req.user.igreja_id, data); }
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.COMUM)
  @ServicoDaRota('OFICIAIS_REGISTRAR')
  cadastrar(@Request() req, @Body() dados: unknown) { return this.pastores.cadastrar(req.user.igreja_id, req.user.sub, dados); }
}
