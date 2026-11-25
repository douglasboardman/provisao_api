import { ServicoDaRota } from '../autorizacao/politica';
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
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.OPERADOR, Perfil.SECRETARIO, Perfil.TESOUREIRO, Perfil.AUDITOR)
export class GruposFamiliaresController {
  constructor(private readonly gruposFamiliaresService: GruposFamiliaresService) {}

  /**
   * Cria um novo grupo familiar na mesma igreja do solicitante.
   * Restrito a ADMIN e GESTOR.
   * Rota: POST /grupos-familiares
   */
  @ServicoDaRota('FAMILIAS_CADASTRAR')
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  create(@Request() req, @Body() createGruposFamiliareDto: CreateGruposFamiliareDto) {
    return this.gruposFamiliaresService.create(req.user.igreja_id, createGruposFamiliareDto, req.user);
  }

  /**
   * Lista todos os grupos familiares da mesma igreja do solicitante.
   * Rota: GET /grupos-familiares
   */
  @ServicoDaRota('FAMILIAS_CONSULTAR')
  @Get()
  findAll(@Request() req) {
    return this.gruposFamiliaresService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna um grupo familiar pelo ID, dentro da mesma igreja.
   * Rota: GET /grupos-familiares/:id
   */
  @ServicoDaRota('FAMILIAS_CONSULTAR')
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.gruposFamiliaresService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza um grupo familiar da mesma igreja.
   * Restrito a ADMIN e GESTOR.
   * Rota: PATCH /grupos-familiares/:id
   */
  @ServicoDaRota('FAMILIAS_EDITAR')
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  update(@Request() req, @Param('id') id: string, @Body() updateGruposFamiliareDto: UpdateGruposFamiliareDto) {
    return this.gruposFamiliaresService.update(id, req.user.igreja_id, updateGruposFamiliareDto, req.user);
  }

  /**
   * Remove um grupo familiar da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /grupos-familiares/:id
   */
  @ServicoDaRota('FAMILIAS_EXCLUIR')
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.SECRETARIO)
  remove(@Request() req, @Param('id') id: string) {
    return this.gruposFamiliaresService.remove(id, req.user.igreja_id, req.user);
  }
}
