import {
  Controller, Get, Post, Body, Patch, Param, Delete, Header,
  UseGuards, UseInterceptors, UploadedFile, BadRequestException, ForbiddenException, Request,
} from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { VincularPessoaDto } from './dto/vincular-pessoa.dto';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard, ALL_ROLES } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { StorageService } from 'src/storage/storage.service';
import { OutboxService } from 'src/outbox/outbox.service';
import { FileInterceptor } from '@nestjs/platform-express';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.TESOUREIRO, Perfil.AUDITOR, Perfil.SECRETARIO)
@Controller('usuarios')
export class UsuariosController {
  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly storageService: StorageService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Cadastra um novo usuário na mesma igreja do solicitante.
   * Restrito ao perfil ADMINISTRADOR.
   * Rota: POST /usuarios
   */
  @Post()
  @Roles(Perfil.ADMINISTRADOR)
  create(@Request() req, @Body() createUsuarioDto: CreateUsuarioDto) {
    return this.usuariosService.create(req.user.igreja_id, createUsuarioDto, req.user.sub);
  }

  /**
   * Lista todos os usuários da mesma igreja do solicitante.
   * Rota: GET /usuarios
   */
  @Get()
  findAll(@Request() req) {
    return this.usuariosService.findAll(req.user.igreja_id);
  }

  @Get('indicadores-fila')
  @Header('Cache-Control', 'private, no-store')
  @Roles(Perfil.ADMINISTRADOR)
  queueSummary(@Request() req) { return this.outbox.summary(req.user.igreja_id); }

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
  @Roles(Perfil.ADMINISTRADOR)
  async update(@Request() req, @Param('id') id: string, @Body() updateUsuarioDto: UpdateUsuarioDto) {
    const target = await this.usuariosService.findOne(id, req.user.igreja_id);
    if (updateUsuarioDto.ativo === true && !target.ativo) {
      throw new BadRequestException('Use o fluxo de ativação para enviar o convite.');
    }
    if (req.user.sub === id && ((updateUsuarioDto.perfil !== undefined && updateUsuarioDto.perfil !== target.perfil) || updateUsuarioDto.ativo === false)) {
      throw new ForbiddenException('Não é permitido alterar o próprio perfil ou desativar a própria conta.');
    }
    return this.usuariosService.update(id, req.user.igreja_id, updateUsuarioDto, req.user.sub);
  }

  @Patch(':id/pessoa')
  @Roles(Perfil.ADMINISTRADOR)
  vincularPessoa(@Request() req, @Param('id') id: string, @Body() dto: VincularPessoaDto) {
    return this.usuariosService.vincularPessoa(id, req.user.igreja_id, dto.pessoa_id, req.user.sub);
  }

  /**
   * Remove um usuário da mesma igreja. Restrito ao ADMINISTRADOR.
   * Rota: DELETE /usuarios/:id
   */
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR)
  remove(@Request() req: any, @Param('id') id: string) {
    if (req.user.sub === id) throw new ForbiddenException('Não é permitido excluir a própria conta.');
    return this.usuariosService.remove(id, req.user.igreja_id, req.user.sub);
  }

  /**
   * Ativa a conta de um usuário pendente e envia o e-mail de boas-vindas
   * com o link para definição de senha. Restrito ao ADMINISTRADOR.
   * Rota: PATCH /usuarios/:id/activate
   */
  @Patch(':id/activate')
  @Roles(Perfil.ADMINISTRADOR)
  activate(@Request() req: any, @Param('id') id: string) {
    return this.usuariosService.activate(id, req.user.igreja_id, req.user.sub);
  }

  @Patch(':id/resend-invite')
  @Roles(Perfil.ADMINISTRADOR)
  async resendInvite(@Request() req, @Param('id') id: string) {
    await this.usuariosService.reissueInvite(id, req.user.igreja_id, req.user.sub);
    return { message: 'Convite enfileirado.' };
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
    return this.usuariosService.update(id, req.user.igreja_id, { url_imagem_perfil: imageUrl }, req.user.sub);
  }
}
