import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe, Request } from '@nestjs/common';
import { ReceitasService } from './receitas.service';
import { CreateReceitaDto } from './dto/create-receita.dto';
import { UpdateReceitaDto } from './dto/update-receita.dto';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO, Perfil.OPERADOR, Perfil.AUDITOR, Perfil.SECRETARIO)
@Controller('receitas')
export class ReceitasController {
  constructor(private readonly receitasService: ReceitasService) {}

  /**
   * Cria um novo tipo de receita na mesma igreja do solicitante.
   * Rota: POST /receitas
   */
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO, Perfil.OPERADOR)
  create(@Request() req, @Body() createReceitaDto: CreateReceitaDto) {
    return this.receitasService.create(req.user.igreja_id, createReceitaDto);
  }

  /**
   * Lista todos os tipos de receita da mesma igreja do solicitante.
   * Rota: GET /receitas
   */
  @Get()
  findAll(@Request() req) {
    return this.receitasService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna um tipo de receita pelo ID, dentro da mesma igreja.
   * Rota: GET /receitas/:id
   */
  @Get(':id')
  findOne(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.receitasService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza um tipo de receita da mesma igreja.
   * Rota: PATCH /receitas/:id
   */
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO, Perfil.OPERADOR)
  update(@Request() req, @Param('id', ParseIntPipe) id: number, @Body() updateReceitaDto: UpdateReceitaDto) {
    return this.receitasService.update(id, req.user.igreja_id, updateReceitaDto);
  }

  /**
   * Remove um tipo de receita da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /receitas/:id
   */
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO)
  remove(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.receitasService.remove(id, req.user.igreja_id);
  }
}
