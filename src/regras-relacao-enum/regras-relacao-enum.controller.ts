import { Controller, Get, Post, Patch, Put, Delete, Param, Body, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { CreateRegraRelacaoEnumDto } from './dto/create-regra-relacao-enum.dto';
import { UpdateRegraRelacaoEnumDto } from './dto/update-regra-relacao-enum.dto';
import { ReplaceValoresDto } from './dto/create-regra-relacao-enum.dto';
import { RegrasRelacaoEnumService } from './regras-relacao-enum.service';

@Controller('regras-relacao-enum')
@UseGuards(AuthGuard, RolesGuard)
export class RegrasRelacaoEnumController {
  constructor(private readonly service: RegrasRelacaoEnumService) {}

  @Get('enums')
  @Roles(Perfil.ADMINISTRADOR, Perfil.SECRETARIO)
  getEnums() {
    return this.service.getEnumsDisponiveis();
  }

  @Get('modulo/:modulo')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.TESOUREIRO, Perfil.OPERADOR, Perfil.AUDITOR)
  getByModulo(@Request() req, @Param('modulo') modulo: string) {
    return this.service.getRegrasPorModulo(modulo, req.user.igreja_id);
  }

  @Put('modulo/membresia/:id/valores')
  @Roles(Perfil.ADMINISTRADOR, Perfil.SECRETARIO)
  replaceValoresDaIgreja(@Request() req, @Param('id') id: string, @Body() dto: ReplaceValoresDto) {
    return this.service.replaceValoresDaIgreja(req.user.igreja_id, id, dto.valores);
  }

  @Get()
  @Roles(Perfil.ADMINISTRADOR)
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @Roles(Perfil.ADMINISTRADOR)
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(Perfil.ADMINISTRADOR)
  create(@Body() dto: CreateRegraRelacaoEnumDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR)
  update(@Param('id') id: string, @Body() dto: UpdateRegraRelacaoEnumDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Put(':id/valores')
  @Roles(Perfil.ADMINISTRADOR)
  replaceValores(@Param('id') id: string, @Body() dto: ReplaceValoresDto) {
    return this.service.replaceValores(id, dto.valores);
  }
}
