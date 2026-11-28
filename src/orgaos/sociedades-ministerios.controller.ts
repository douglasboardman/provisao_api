import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { ContaComum } from '../autorizacao/politica';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { OrgaosGestaoGuard } from './orgaos-gestao.guard';
import { OrgaosGuard } from './orgaos.guard';
import { SociedadesMinisteriosService } from './sociedades-ministerios.service';

@Controller('orgaos/institucional')
@UseGuards(AuthGuard, RolesGuard, OrgaosGuard, OrgaosGestaoGuard)
@Roles(Perfil.COMUM)
export class SociedadesMinisteriosController {
  constructor(private readonly service: SociedadesMinisteriosService) {}

  @Post('ministerios')
  @ContaComum()
  criar(@Request() req, @Body() dados: unknown) {
    return this.service.criar(req.user, dados);
  }

  @Get(':id')
  @ContaComum()
  @Header('Cache-Control', 'private, no-store')
  consultar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Query('busca') busca?: string, @Query('data') data?: string, @Query('supervisao') supervisao?: string) {
    return this.service.consultar(req.user, id, busca, data, supervisao === '1');
  }

  @Post(':id/atos')
  @ContaComum()
  executar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.service.executar(req.user, id, dados);
  }
}
