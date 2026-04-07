import {
  Controller, Get, Post, Body, Patch, Param, Delete,
  UseGuards, UseInterceptors, UploadedFile, BadRequestException, ForbiddenException, Request,
} from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard, ALL_ROLES } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { StorageService } from 'src/storage/storage.service';
import { FileInterceptor } from '@nestjs/platform-express';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO, Perfil.AUDITOR)
@Controller('usuarios')
export class UsuariosController {
  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Cadastra um novo usuário na mesma igreja do solicitante.
   * Restrito ao perfil ADMINISTRADOR.
   * Rota: POST /usuarios
   */
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR)
  create(@Request() req, @Body() createUsuarioDto: CreateUsuarioDto) {
    return this.usuariosService.create(req.user.igreja_id, createUsuarioDto);
  }

  /**
   * Lista todos os usuários da mesma igreja do solicitante.
   * Rota: GET /usuarios
   */
  @Get()
  findAll(@Request() req) {
    return this.usuariosService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna um usuário pelo ID, dentro da mesma igreja.
   * Rota: GET /usuarios/:id
   */
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.usuariosService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza um usuário da mesma igreja. Restrito ao ADMINISTRADOR.
   * Rota: PATCH /usuarios/:id
   */
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR)
  update(@Request() req, @Param('id') id: string, @Body() updateUsuarioDto: UpdateUsuarioDto) {
    return this.usuariosService.update(id, req.user.igreja_id, updateUsuarioDto);
  }

  /**
   * Remove um usuário da mesma igreja. Restrito ao ADMINISTRADOR.
   * Rota: DELETE /usuarios/:id
   */
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR)
  remove(@Request() req: any, @Param('id') id: string) {
    return this.usuariosService.remove(id, req.user.igreja_id);
  }

  /**
   * Ativa a conta de um usuário pendente e envia o e-mail de boas-vindas
   * com o link para definição de senha. Restrito ao ADMINISTRADOR.
   * Rota: PATCH /usuarios/:id/activate
   */
  @Patch(':id/activate')
  @Roles(Perfil.ADMINISTRADOR)
  activate(@Request() req: any, @Param('id') id: string) {
    return this.usuariosService.activate(id, req.user.igreja_id);
  }

  /**
   * Faz upload da imagem de perfil de um usuário.
   * Permitido ao próprio usuário ou a um ADMINISTRADOR da mesma igreja.
   * Rota: PATCH /usuarios/:id/profile-image
   */
  @Patch(':id/profile-image')
  @Roles(...ALL_ROLES)
  @UseInterceptors(FileInterceptor('file'))
  async uploadProfileImage(
    @Request() req: any,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Nenhum arquivo foi enviado.');
    }

    const isSelf = req.user.sub === id;
    const isAdmin = req.user.perfil === Perfil.ADMINISTRADOR;
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException('Sem permissão para alterar a imagem de outro usuário.');
    }

    const imageUrl = await this.storageService.uploadFile(file, 'user-profiles');
    return this.usuariosService.update(id, req.user.igreja_id, { url_imagem_perfil: imageUrl });
  }
}
