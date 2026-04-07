import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import { VinculosMembresiaService } from './vinculos-membresia.service';
import { CreateVinculosMembresiaDto } from './dto/create-vinculos-membresia.dto';
import { UpdateVinculosMembresiaDto } from './dto/update-vinculos-membresia.dto';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';

/**
 * Controller responsável por gerir todas as operações relacionadas a Vínculos de Membresia.
 * Protegido por autenticação e restrito aos perfis de ADMIN, GESTOR e OPERADOR por padrão.
 */
@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.OPERADOR)
@Controller('vinculos-membresia')
export class VinculosMembresiaController {
  constructor(private readonly vinculosMembresiaService: VinculosMembresiaService) {}

  /**
   * Cria um novo vínculo de membresia na mesma igreja do solicitante.
   * Restrito a ADMIN e GESTOR.
   * Rota: POST /vinculos-membresia
   */
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR)
  create(@Request() req, @Body() createVinculosMembresiaDto: CreateVinculosMembresiaDto) {
    return this.vinculosMembresiaService.create(req.user.igreja_id, createVinculosMembresiaDto);
  }

  /**
   * Lista todos os vínculos de membresia da mesma igreja do solicitante.
   * Rota: GET /vinculos-membresia
   */
  @Get()
  findAll(@Request() req) {
    return this.vinculosMembresiaService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna um vínculo de membresia pelo ID, dentro da mesma igreja.
   * Rota: GET /vinculos-membresia/:id
   */
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.vinculosMembresiaService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza um vínculo de membresia da mesma igreja.
   * Restrito a ADMIN e GESTOR.
   * Rota: PATCH /vinculos-membresia/:id
   */
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR)
  update(@Request() req, @Param('id') id: string, @Body() updateVinculosMembresiaDto: UpdateVinculosMembresiaDto) {
    return this.vinculosMembresiaService.update(id, req.user.igreja_id, updateVinculosMembresiaDto);
  }

  /**
   * Remove um vínculo de membresia da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /vinculos-membresia/:id
   */
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR)
  remove(@Request() req, @Param('id') id: string) {
    return this.vinculosMembresiaService.remove(id, req.user.igreja_id);
  }
}
