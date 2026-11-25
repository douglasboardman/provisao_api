import { ObservarServico, ServicoDaRota } from '../autorizacao/politica';
import {
  Controller, Get, Post, Body, Patch, Param, Delete, UseGuards,
  UseInterceptors, UploadedFile, BadRequestException, Request,
} from '@nestjs/common';
import { PessoasService } from './pessoas.service';
import { CreatePessoaDto } from './dto/create-pessoa.dto';
import { UpdatePessoaDto } from './dto/update-pessoa.dto';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { AuthGuard } from 'src/auth/auth.guard';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { StorageService } from 'src/storage/storage.service';
import { FileInterceptor } from '@nestjs/platform-express';

/**
 * Controller responsável por gerir todas as operações relacionadas a Pessoas.
 * Protegido por autenticação e restrito aos perfis de ADMIN, GESTOR e OPERADOR por padrão.
 */
@Controller('pessoas')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.OPERADOR, Perfil.SECRETARIO, Perfil.TESOUREIRO, Perfil.AUDITOR)
export class PessoasController {
  constructor(
    private readonly pessoasService: PessoasService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Cria um novo registro de pessoa na mesma igreja do solicitante.
   * Acesso restrito aos perfis ADMIN e GESTOR.
   * Rota: POST /pessoas
   */
  @ObservarServico('PESSOAS_CADASTRAR')
  @ServicoDaRota('PESSOAS_CADASTRAR')
  @Post()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.TESOUREIRO)
  create(@Request() req, @Body() createPessoaDto: CreatePessoaDto) {
    return this.pessoasService.create(req.user.igreja_id, createPessoaDto, req.user);
  }

  /**
   * Lista todas as pessoas da mesma igreja do solicitante.
   * Rota: GET /pessoas
   */
  @ObservarServico('PESSOAS_CONSULTAR')
  @ServicoDaRota('PESSOAS_CONSULTAR')
  @Get()
  findAll(@Request() req) {
    return this.pessoasService.findAll(req.user.igreja_id);
  }

  /**
   * Retorna uma pessoa pelo ID, dentro da mesma igreja.
   * Rota: GET /pessoas/:id
   */
  @ServicoDaRota('PESSOAS_CONSULTAR')
  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.pessoasService.findOne(id, req.user.igreja_id);
  }

  /**
   * Atualiza uma pessoa da mesma igreja. Restrito a ADMIN e GESTOR.
   * Rota: PATCH /pessoas/:id
   */
  @ServicoDaRota('PESSOAS_EDITAR')
  @Patch(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.TESOUREIRO)
  update(@Request() req, @Param('id') id: string, @Body() updatePessoaDto: UpdatePessoaDto) {
    return this.pessoasService.update(id, req.user.igreja_id, updatePessoaDto, req.user);
  }

  /**
   * Remove uma pessoa da mesma igreja. Restrito ao ADMIN.
   * Rota: DELETE /pessoas/:id
   */
  @ServicoDaRota('PESSOAS_EXCLUIR')
  @Delete(':id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.SECRETARIO)
  remove(@Request() req, @Param('id') id: string) {
    return this.pessoasService.remove(id, req.user.igreja_id, req.user);
  }

  /**
   * Faz upload e associa uma foto a uma pessoa da mesma igreja.
   * Rota: PATCH /pessoas/atrib-foto-pessoa/:id
   */
  @ServicoDaRota('PESSOAS_EDITAR')
  @Patch('atrib-foto-pessoa/:id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.TESOUREIRO)
  @UseInterceptors(FileInterceptor('file'))
  async uploadFotoPessoa(
    @Request() req,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Nenhum ficheiro foi enviado');
    }

    await this.pessoasService.findOne(id, req.user.igreja_id);
    const fotoUrl = await this.storageService.uploadFile(file, 'fotos-pessoas');
    return this.pessoasService.update(id, req.user.igreja_id, { url_foto: fotoUrl }, req.user);
  }

  /**
   * Associa uma pessoa a um grupo familiar, ambos da mesma igreja.
   * Rota: PATCH /pessoas/atrib-grupo-familiar/:idPessoa/:idFamilia
   */
  @ServicoDaRota('PESSOAS_EDITAR')
  @Patch('atrib-grupo-familiar/:idPessoa/:idFamilia')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.TESOUREIRO)
  setFamilia(
    @Request() req,
    @Param('idPessoa') idPessoa: string,
    @Param('idFamilia') idGrupoFamiliar: string,
  ) {
    const idFamilia = idGrupoFamiliar !== 'null' ? idGrupoFamiliar : null;
    return this.pessoasService.setFamilia(idPessoa, idFamilia, req.user.igreja_id, req.user);
  }
}
