import { ServicoDaRota } from '../autorizacao/politica';
import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import { AcoesService } from './acoes.service';
import { CreateAcoeDto } from './dto/create-acoe.dto';
import { UpdateAcoeDto } from './dto/update-acoe.dto';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard, ALL_ROLES } from 'src/auth/guards/roles/roles.guard';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO)
@Controller('acoes')
export class AcoesController {
  constructor(private readonly acoesService: AcoesService) {}

  /**
   * Cria uma nova ação na mesma igreja do solicitante.
   * Rota: POST /acoes
   */
  @ServicoDaRota('ACOES_CADASTRAR')
  @Post()
  create(@Request() req, @Body() createAcoeDto: CreateAcoeDto) {
    return this.acoesService.create(req.user.igreja_id, createAcoeDto, req.user);
  }

  /**
   * Lista todas as ações da mesma igreja do solicitante.
   * Rota: GET /acoes
   */
  @Roles(...ALL_ROLES)
  @ServicoDaRota('ACOES_CONSULTAR')
  @Get()
  findAll(@Request() req) {
    return this.acoesService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna uma ação pelo ID, dentro da mesma igreja.
   * Rota: GET /acoes/:id
   */
  @Roles(...ALL_ROLES)
  @ServicoDaRota('ACOES_CONSULTAR')
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.acoesService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza uma ação da mesma igreja.
   * Rota: PATCH /acoes/:id
   */
  @ServicoDaRota('ACOES_EDITAR')
  @Patch(':id')
  update(@Request() req, @Param('id') id: string, @Body() updateAcoeDto: UpdateAcoeDto) {
    return this.acoesService.update(id, req.user.igreja_id, updateAcoeDto, req.user);
  }

  /**
   * Remove uma ação da mesma igreja.
   * Rota: DELETE /acoes/:id
   */
  @ServicoDaRota('ACOES_EXCLUIR')
  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.acoesService.remove(id, req.user.igreja_id, req.user);
  }
}
