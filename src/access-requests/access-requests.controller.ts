import { ServicoDaRota } from '../autorizacao/politica';
import { Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { usuarios_perfil } from '@prisma/client';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { AccessAuthorityService } from './access-authority.service';
import { AccessAuthorityDto } from './access-authority.dto';
import { AccessRequestsService } from './access-requests.service';
@Controller('solicitacoes-acesso')
@UseGuards(AuthGuard, RolesGuard)
@Roles(usuarios_perfil.ADMINISTRADOR, usuarios_perfil.COMUM)
export class AccessRequestsController {
  constructor(private readonly service: AccessRequestsService, private readonly authority: AccessAuthorityService) {}
  @ServicoDaRota('ACESSO_CONSULTAR')
  @Get() list(@Request() req, @Query('pagina') pagina?: string) { return this.service.list(req.user.igreja_id, req.user.sub, pagina); }
  @ServicoDaRota('ACESSO_ANALISAR')
  @Patch(':id/aprovar') approve(@Request() req, @Param('id') id: string) { return this.service.decide(id, req.user.igreja_id, req.user.sub, true, req.user); }
  @ServicoDaRota('ACESSO_ANALISAR')
  @Patch(':id/rejeitar') reject(@Request() req, @Param('id') id: string) { return this.service.decide(id, req.user.igreja_id, req.user.sub, false, req.user); }
}
