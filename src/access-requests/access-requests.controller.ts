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
@Roles(usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR)
export class AccessRequestsController {
  constructor(private readonly service: AccessRequestsService, private readonly authority: AccessAuthorityService) {}
  @Get() list(@Request() req, @Query('pagina') pagina?: string) { return this.service.list(req.user.igreja_id, req.user.sub, pagina); }
  @Get('competencias')
  @Roles(usuarios_perfil.ADMINISTRADOR)
  listAuthorities(@Request() req) { return this.authority.list(req.user.igreja_id); }
  @Post('competencias')
  @Roles(usuarios_perfil.ADMINISTRADOR)
  grantAuthority(@Request() req, @Body() dto: AccessAuthorityDto) { return this.authority.grant(req.user.igreja_id, req.user.sub, dto.usuario_id, dto.referencia); }
  @Patch('competencias/:id/revogar')
  @Roles(usuarios_perfil.ADMINISTRADOR)
  revokeAuthority(@Request() req, @Param('id') id: string) { return this.authority.revoke(req.user.igreja_id, req.user.sub, id); }
  @Patch(':id/aprovar') approve(@Request() req, @Param('id') id: string) { return this.service.decide(id, req.user.igreja_id, req.user.sub, true); }
  @Patch(':id/rejeitar') reject(@Request() req, @Param('id') id: string) { return this.service.decide(id, req.user.igreja_id, req.user.sub, false); }
}
