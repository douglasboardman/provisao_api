import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe, Request } from '@nestjs/common';
import { DespesasService } from './despesas.service';
import { CreateDespesaDto } from './dto/create-despesa.dto';
import { UpdateDespesaDto } from './dto/update-despesa.dto';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO, Perfil.OPERADOR, Perfil.AUDITOR, Perfil.SECRETARIO)
@Controller('despesas')
export class DespesasController {
  constructor(private readonly despesasService: DespesasService) {}

  /**
   * Cria um novo tipo de despesa na mesma igreja do solicitante.
   * Rota: POST /despesas
   */
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO, Perfil.OPERADOR)
  create(@Request() req, @Body() createDespesaDto: CreateDespesaDto) {
    return this.despesasService.create(req.user.igreja_id, createDespesaDto);
  }

  /**
   * Lista todos os tipos de despesa da mesma igreja do solicitante.
   * Rota: GET /despesas
   */
  @Get()
  findAll(@Request() req) {
    return this.despesasService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna um tipo de despesa pelo ID, dentro da mesma igreja.
   * Rota: GET /despesas/:id
   */
  @Get(':id')
  findOne(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.despesasService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza um tipo de despesa da mesma igreja.
   * Rota: PATCH /despesas/:id
   */
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO, Perfil.OPERADOR)
  update(@Request() req, @Param('id', ParseIntPipe) id: number, @Body() updateDespesaDto: UpdateDespesaDto) {
    return this.despesasService.update(id, req.user.igreja_id, updateDespesaDto);
  }

  /**
   * Remove um tipo de despesa da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /despesas/:id
   */
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO)
  remove(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.despesasService.remove(id, req.user.igreja_id);
  }
}
