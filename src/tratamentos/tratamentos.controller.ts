import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe } from '@nestjs/common';
import { TratamentosService } from './tratamentos.service';
import { CreateTratamentoDto } from './dto/create-tratamento.dto';
import { UpdateTratamentoDto } from './dto/update-tratamento.dto';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO, Perfil.OPERADOR, Perfil.AUDITOR, Perfil.SECRETARIO)
@Controller('tratamentos')
export class TratamentosController {
  constructor(private readonly tratamentosService: TratamentosService) {}

  @Post()
  @Roles(Perfil.ADMINISTRADOR)
  create(@Body() dto: CreateTratamentoDto) {
    return this.tratamentosService.create(dto);
  }

  @Get()
  findAll() {
    return this.tratamentosService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.tratamentosService.findOne(id);
  }

  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR)
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTratamentoDto) {
    return this.tratamentosService.update(id, dto);
  }

  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.tratamentosService.remove(id);
  }
}
