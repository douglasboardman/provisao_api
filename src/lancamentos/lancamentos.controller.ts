import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request, Query } from '@nestjs/common';
import { LancamentosService } from './lancamentos.service';
import { CreateLancamentoDto } from './dto/create-lancamento.dto';
import { UpdateLancamentoDto } from './dto/update-lancamento.dto';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard, ALL_ROLES } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';

@UseGuards(AuthGuard, RolesGuard)
@Roles(...ALL_ROLES)
@Controller('lancamentos')
export class LancamentosController {
  constructor(private readonly lancamentosService: LancamentosService) {}

  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO, Perfil.OPERADOR)
  create(@Request() req, @Body() dto: CreateLancamentoDto) {
    return this.lancamentosService.create(req.user.igreja_id, req.user.sub, dto);
  }

  @Get()
  findAll(@Request() req, @Query('tipo') tipo?: string, @Query('conta_id') conta_id?: string, @Query('page') page?: string) {
    return this.lancamentosService.findAll(req.user.igreja_id, {
      tipo, conta_id, page: page ? (parseInt(page) || 1) : 1,
    });
  }

  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.lancamentosService.findOne(id, req.user.igreja_id);
  }

  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO, Perfil.OPERADOR)
  update(@Request() req, @Param('id') id: string, @Body() dto: UpdateLancamentoDto) {
    return this.lancamentosService.update(id, req.user.igreja_id, dto);
  }

  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.TESOUREIRO)
  remove(@Request() req, @Param('id') id: string) {
    return this.lancamentosService.remove(id, req.user.igreja_id);
  }
}
