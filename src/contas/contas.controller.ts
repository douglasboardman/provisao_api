import { ServicoDaRota } from '../autorizacao/politica';
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
 * Acesso conforme as atribuições de serviço da conta.
 */
@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
@Controller('contas')
export class ContasController {
  constructor(private readonly contasService: ContasService) {}

  /**
   * Cria uma nova conta na mesma igreja do solicitante.
 * Acesso conforme as atribuições de serviço da conta.
   * Rota: POST /contas
   */
  @ServicoDaRota('CONTAS_CADASTRAR')
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.COMUM)
  create(@Request() req, @Body() createContaDto: CreateContaDto) {
    return this.contasService.create(req.user.igreja_id, createContaDto, req.user);
  }

  /**
   * Lista todas as contas da mesma igreja do solicitante.
   * Rota: GET /contas
   */
  @ServicoDaRota('CONTAS_CONSULTAR')
  @Get()
  findAll(@Request() req) {
    return this.contasService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna uma conta pelo ID, dentro da mesma igreja.
   * Rota: GET /contas/:id
   */
  @ServicoDaRota('CONTAS_CONSULTAR')
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.contasService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza uma conta da mesma igreja.
 * Acesso conforme as atribuições de serviço da conta.
   * Rota: PATCH /contas/:id
   */
  @ServicoDaRota('CONTAS_EDITAR')
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.COMUM)
  update(@Request() req, @Param('id') id: string, @Body() updateContaDto: UpdateContaDto) {
    return this.contasService.update(id, req.user.igreja_id, updateContaDto, req.user);
  }

  /**
   * Remove uma conta da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /contas/:id
   */
  @ServicoDaRota('CONTAS_EXCLUIR')
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.COMUM)
  remove(@Request() req, @Param('id') id: string) {
    return this.contasService.remove(id, req.user.igreja_id, req.user);
  }
}
