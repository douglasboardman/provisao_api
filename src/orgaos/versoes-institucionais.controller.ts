import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Put, Request, UseGuards } from '@nestjs/common';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { ContaComum } from '../autorizacao/politica';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { OrgaosGestaoGuard } from './orgaos-gestao.guard';
import { OrgaosGuard } from './orgaos.guard';
import { VersoesInstitucionaisService } from './versoes-institucionais.service';

@Controller('orgaos/:id/configuracao')
@UseGuards(AuthGuard, RolesGuard, OrgaosGuard, OrgaosGestaoGuard)
@Roles(Perfil.COMUM, Perfil.ADMINISTRADOR)
export class VersoesInstitucionaisController {
  constructor(private readonly versoes: VersoesInstitucionaisService) {}

  @Get()
  @ContaComum()
  @Header('Cache-Control', 'private, no-store')
  listar(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.versoes.listar(req.user, id);
  }

  @Put('proposta')
  @ContaComum()
  propor(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.versoes.propor(req.user, id, dados);
  }

  @Post('adotar')
  @ContaComum()
  adotar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.versoes.adotar(req.user, id, dados);
  }
}
