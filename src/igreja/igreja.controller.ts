import { ServicoDaRota } from '../autorizacao/politica';
import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IgrejaService } from './igreja.service';
import { CreateIgrejaDto } from './dto/create-igreja.dto';
import { UpdateIgrejaDto } from './dto/update-igreja.dto';
import { AdminKeyGuard } from './guards/admin-key.guard';
import { AuthGuard } from 'src/auth/auth.guard';
import { ALL_ROLES, RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { solicitacaoDisponivel } from '../feature-flags/feature-flags';

@Controller('igrejas')
export class IgrejaController {
  constructor(private readonly igrejaService: IgrejaService) {}

  @Get()
  async findAllPublic(@Query('cadastro') cadastro?: string) {
    const igrejas = await this.igrejaService.findAllPublic();
    return cadastro === '1' ? igrejas.filter(igreja => solicitacaoDisponivel(igreja.id)) : igrejas;
  }

  @Post()
  @UseGuards(AdminKeyGuard)
  create(@Body() dto: CreateIgrejaDto) {
    return this.igrejaService.create(dto);
  }

  @ServicoDaRota('IGREJA_CONSULTAR')
  @Get('me')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(...ALL_ROLES)
  findMe(@Request() req) {
    return this.igrejaService.findMe(req.user.igreja_id);
  }

  @ServicoDaRota('IGREJA_EDITAR')
  @Patch('me')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  updateMe(@Request() req, @Body() dto: UpdateIgrejaDto) {
    return this.igrejaService.updateMe(req.user.igreja_id, dto, req.user);
  }

  @ServicoDaRota('IGREJA_EDITAR')
  @Patch('me/logo')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  @UseInterceptors(FileInterceptor('file'))
  updateLogo(@Request() req, @UploadedFile() file: Express.Multer.File) {
    return this.igrejaService.updateLogo(req.user.igreja_id, file, req.user);
  }

  @ServicoDaRota('IGREJA_CONSULTAR')
  @Get('me/congregacoes')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(...ALL_ROLES)
  findCongregacoes(@Request() req) {
    return this.igrejaService.findCongregacoes(req.user.igreja_id);
  }
}
