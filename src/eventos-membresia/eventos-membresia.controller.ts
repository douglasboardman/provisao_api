import { ServicoDaRota } from '../autorizacao/politica';
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  ParseUUIDPipe,
  Delete,
  UseGuards,
  Request,
} from '@nestjs/common';
import { OrdenacaoMembresiaService } from '../oficiais/ordenacao-membresia.service';
import { GovernancaGuard } from '../oficiais/governanca.guard';
import { EventosMembresiaService } from './eventos-membresia.service';
import { CreateEventoMembresiaDto } from './dto/create-evento-membresia.dto';
import { UpdateEventoMembresiaDto } from './dto/update-evento-membresia.dto';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';

@UseGuards(AuthGuard, RolesGuard)
@Roles(
  Perfil.ADMINISTRADOR,
  Perfil.GESTOR,
  Perfil.OPERADOR,
  Perfil.SECRETARIO,
  Perfil.TESOUREIRO,
  Perfil.AUDITOR,
)
@Controller('eventos-membresia')
export class EventosMembresiaController {
  constructor(private readonly service: EventosMembresiaService, private readonly ordenacao: OrdenacaoMembresiaService) {}

  @ServicoDaRota('MEMBRESIA_REGISTRAR')
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  create(@Request() req, @Body() dto: CreateEventoMembresiaDto) {
    return this.service.create(req.user.igreja_id, dto, req.user);
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_RETIFICAR')
  @Post(':id/ordem-inicial')
  @UseGuards(GovernancaGuard)
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  ordenarAtoIsolado(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OrdenacaoMembresiaService['ordenarUnico']>[3]) {
    return this.ordenacao.ordenarUnico(req.user.igreja_id, req.user.sub, id, dados, req.user);
  }

  @ServicoDaRota('MEMBRESIA_CONSULTAR')
  @Get()
  findAll(@Request() req) {
    return this.service.findAll(req.user.igreja_id);
  }

  @ServicoDaRota('MEMBRESIA_CONSULTAR')
  @Get('pessoa/:pessoaId')
  findByPessoa(@Request() req, @Param('pessoaId') pessoaId: string) {
    return this.service.findByPessoa(pessoaId, req.user.igreja_id);
  }

  @ServicoDaRota('MEMBRESIA_CONSULTAR')
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.service.findOne(id, req.user.igreja_id);
  }

  @ServicoDaRota('MEMBRESIA_EDITAR')
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateEventoMembresiaDto,
  ) {
    return this.service.update(id, req.user.igreja_id, dto, req.user);
  }

  @ServicoDaRota('MEMBRESIA_EXCLUIR')
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.SECRETARIO)
  remove(@Request() req, @Param('id') id: string) {
    return this.service.remove(id, req.user.igreja_id, req.user);
  }
}
