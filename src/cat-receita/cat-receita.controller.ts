import { ServicoDaRota } from '../autorizacao/politica';
import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe, Request } from '@nestjs/common';
import { CatReceitaService } from './cat-receita.service';
import { CreateCatReceitaDto } from './dto/create-cat-receita.dto';
import { UpdateCatReceitaDto } from './dto/update-cat-receita.dto';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO, Perfil.OPERADOR, Perfil.AUDITOR, Perfil.SECRETARIO)
@Controller('cat-receita')
export class CatReceitaController {
  constructor(private readonly catReceitaService: CatReceitaService) {}

  /**
   * Cria uma nova categoria de receita na mesma igreja do solicitante.
   * Restrito a ADMIN e TESOUREIRO.
   * Rota: POST /cat-receita
   */
  @ServicoDaRota('CATEGORIAS_RECEITA_CADASTRAR')
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO)
  create(@Request() req, @Body() createCatReceitaDto: CreateCatReceitaDto) {
    return this.catReceitaService.create(req.user.igreja_id, createCatReceitaDto, req.user);
  }

  /**
   * Lista todas as categorias de receita da mesma igreja do solicitante.
   * Rota: GET /cat-receita
   */
  @ServicoDaRota('CATEGORIAS_RECEITA_CONSULTAR')
  @Get()
  findAll(@Request() req) {
    return this.catReceitaService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna uma categoria de receita pelo ID, dentro da mesma igreja.
   * Rota: GET /cat-receita/:id
   */
  @ServicoDaRota('CATEGORIAS_RECEITA_CONSULTAR')
  @Get(':id')
  findOne(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.catReceitaService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza uma categoria de receita da mesma igreja.
   * Restrito a ADMIN e TESOUREIRO.
   * Rota: PATCH /cat-receita/:id
   */
  @ServicoDaRota('CATEGORIAS_RECEITA_EDITAR')
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO)
  update(@Request() req, @Param('id', ParseIntPipe) id: number, @Body() updateCatReceitaDto: UpdateCatReceitaDto) {
    return this.catReceitaService.update(id, req.user.igreja_id, updateCatReceitaDto, req.user);
  }

  /**
   * Remove uma categoria de receita da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /cat-receita/:id
   */
  @ServicoDaRota('CATEGORIAS_RECEITA_EXCLUIR')
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO)
  remove(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.catReceitaService.remove(id, req.user.igreja_id, req.user);
  }
}
