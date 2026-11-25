import { ServicoDaRota } from '../autorizacao/politica';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ALL_ROLES, RolesGuard } from '../auth/guards/roles/roles.guard';
import { SalvarProfissaoDto } from './profissoes.dto';
import { ProfissoesService } from './profissoes.service';

@Controller('profissoes')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.SECRETARIO)
export class ProfissoesController {
  constructor(private readonly profissoes: ProfissoesService) {}

  @ServicoDaRota('PROFISSOES_CONSULTAR')
  @Get()
  @Roles(...ALL_ROLES)
  listar(@Request() req) {
    return this.profissoes.listar(req.user.igreja_id);
  }

  @ServicoDaRota('PROFISSOES_CADASTRAR')
  @Post()
  criar(@Request() req, @Body() dados: SalvarProfissaoDto) {
    return this.profissoes.criar(req.user.igreja_id, dados, req.user);
  }

  @ServicoDaRota('PROFISSOES_EDITAR')
  @Patch(':id')
  atualizar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: SalvarProfissaoDto) {
    return this.profissoes.atualizar(req.user.igreja_id, id, dados, req.user);
  }

  @ServicoDaRota('PROFISSOES_EXCLUIR')
  @Delete(':id')
  excluir(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.profissoes.excluir(req.user.igreja_id, id, req.user);
  }
}
