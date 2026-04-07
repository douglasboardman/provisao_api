import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe, Request } from '@nestjs/common';
import { CatDespesaService } from './cat-despesa.service';
import { CreateCatDespesaDto } from './dto/create-cat-despesa.dto';
import { UpdateCatDespesaDto } from './dto/update-cat-despesa.dto';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO, Perfil.OPERADOR, Perfil.AUDITOR, Perfil.SECRETARIO)
@Controller('cat-despesa')
export class CatDespesaController {
  constructor(private readonly catDespesaService: CatDespesaService) {}

  /**
   * Cria uma nova categoria de despesa na mesma igreja do solicitante.
   * Restrito a ADMIN e TESOUREIRO.
   * Rota: POST /cat-despesa
   */
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO)
  create(@Request() req, @Body() createCatDespesaDto: CreateCatDespesaDto) {
    return this.catDespesaService.create(req.user.igreja_id, createCatDespesaDto);
  }

  /**
   * Lista todas as categorias de despesa da mesma igreja do solicitante.
   * Rota: GET /cat-despesa
   */
  @Get()
  findAll(@Request() req) {
    return this.catDespesaService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna uma categoria de despesa pelo ID, dentro da mesma igreja.
   * Rota: GET /cat-despesa/:id
   */
  @Get(':id')
  findOne(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.catDespesaService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza uma categoria de despesa da mesma igreja.
   * Restrito a ADMIN e TESOUREIRO.
   * Rota: PATCH /cat-despesa/:id
   */
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO)
  update(@Request() req, @Param('id', ParseIntPipe) id: number, @Body() updateCatDespesaDto: UpdateCatDespesaDto) {
    return this.catDespesaService.update(id, req.user.igreja_id, updateCatDespesaDto);
  }

  /**
   * Remove uma categoria de despesa da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /cat-despesa/:id
   */
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO)
  remove(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.catDespesaService.remove(id, req.user.igreja_id);
  }
}
