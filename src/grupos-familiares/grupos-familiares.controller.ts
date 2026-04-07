import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import { GruposFamiliaresService } from './grupos-familiares.service';
import { CreateGruposFamiliareDto } from './dto/create-grupos-familiare.dto';
import { UpdateGruposFamiliareDto } from './dto/update-grupos-familiare.dto';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { AuthGuard } from 'src/auth/auth.guard';

/**
 * Controller responsável por gerir todas as operações relacionadas a Grupos Familiares.
 * Protegido por autenticação e restrito aos perfis de ADMIN, GESTOR e OPERADOR por padrão.
 */
@Controller('grupos-familiares')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.OPERADOR)
export class GruposFamiliaresController {
  constructor(private readonly gruposFamiliaresService: GruposFamiliaresService) {}

  /**
   * Cria um novo grupo familiar na mesma igreja do solicitante.
   * Restrito a ADMIN e GESTOR.
   * Rota: POST /grupos-familiares
   */
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR)
  create(@Request() req, @Body() createGruposFamiliareDto: CreateGruposFamiliareDto) {
    return this.gruposFamiliaresService.create(req.user.igreja_id, createGruposFamiliareDto);
  }

  /**
   * Lista todos os grupos familiares da mesma igreja do solicitante.
   * Rota: GET /grupos-familiares
   */
  @Get()
  findAll(@Request() req) {
    return this.gruposFamiliaresService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna um grupo familiar pelo ID, dentro da mesma igreja.
   * Rota: GET /grupos-familiares/:id
   */
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.gruposFamiliaresService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza um grupo familiar da mesma igreja.
   * Restrito a ADMIN e GESTOR.
   * Rota: PATCH /grupos-familiares/:id
   */
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR)
  update(@Request() req, @Param('id') id: string, @Body() updateGruposFamiliareDto: UpdateGruposFamiliareDto) {
    return this.gruposFamiliaresService.update(id, req.user.igreja_id, updateGruposFamiliareDto);
  }

  /**
   * Remove um grupo familiar da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /grupos-familiares/:id
   */
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR)
  remove(@Request() req, @Param('id') id: string) {
    return this.gruposFamiliaresService.remove(id, req.user.igreja_id);
  }
}
