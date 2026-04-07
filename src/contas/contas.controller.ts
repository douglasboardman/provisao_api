import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import { ContasService } from './contas.service';
import { CreateContaDto } from './dto/create-conta.dto';
import { UpdateContaDto } from './dto/update-conta.dto';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';

/**
 * Controller responsável por gerir todas as operações relacionadas a Contas bancárias.
 * Leitura: todos os perfis. Escrita: ADMIN, GESTOR, TESOUREIRO. Exclusão: ADMIN.
 */
@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO, Perfil.OPERADOR, Perfil.AUDITOR, Perfil.SECRETARIO)
@Controller('contas')
export class ContasController {
  constructor(private readonly contasService: ContasService) {}

  /**
   * Cria uma nova conta na mesma igreja do solicitante.
   * Restrito a ADMIN e GESTOR.
   * Rota: POST /contas
   */
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO)
  create(@Request() req, @Body() createContaDto: CreateContaDto) {
    return this.contasService.create(req.user.igreja_id, createContaDto);
  }

  /**
   * Lista todas as contas da mesma igreja do solicitante.
   * Rota: GET /contas
   */
  @Get()
  findAll(@Request() req) {
    return this.contasService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna uma conta pelo ID, dentro da mesma igreja.
   * Rota: GET /contas/:id
   */
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.contasService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza uma conta da mesma igreja.
   * Restrito a ADMIN e GESTOR.
   * Rota: PATCH /contas/:id
   */
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO)
  update(@Request() req, @Param('id') id: string, @Body() updateContaDto: UpdateContaDto) {
    return this.contasService.update(id, req.user.igreja_id, updateContaDto);
  }

  /**
   * Remove uma conta da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /contas/:id
   */
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO)
  remove(@Request() req, @Param('id') id: string) {
    return this.contasService.remove(id, req.user.igreja_id);
  }
}
