import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { LivrosService } from './livros.service';
import type { AtorSecretaria } from './secretaria-base.service';
import { SecretariaGuard } from './secretaria.guard';
import { codigo, validar } from './secretaria.dto';

type RequestSecretaria = { user: AtorSecretaria };

@Controller('secretaria/livros')
@UseGuards(AuthGuard, RolesGuard, SecretariaGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR)
export class LivrosController {
  constructor(private readonly livros: LivrosService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  listar(
    @Request() req: RequestSecretaria,
    @Query('contexto', ParseUUIDPipe) contexto: string,
    @Query('pagina', new DefaultValuePipe(0), ParseIntPipe) pagina: number,
    @Query('serie') serie: unknown,
    @Query('estado') estado: unknown,
    @Query('restrito', new ParseBoolPipe({ optional: true })) restrito?: boolean,
  ) {
    if (pagina < 0 || pagina > 100000) throw new BadRequestException('Página inválida.');
    return this.livros.listar(
      req.user,
      contexto,
      pagina,
      restrito === undefined
        ? undefined
        : {
            serie: validar(z.optional(codigo), serie),
            estado: validar(z.enum(['ABERTO', 'EM_PREPARACAO', 'EM_ENCERRAMENTO']).optional(), estado),
            restrito,
          },
    );
  }

  @Post()
  criar(@Request() req: RequestSecretaria, @Body() dados: unknown) {
    return this.livros.criar(req.user, dados);
  }

  @Post('importar')
  importar(@Request() req: RequestSecretaria, @Body() dados: unknown) {
    return this.livros.importar(req.user, dados);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  detalhe(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) {
    return this.livros.detalhe(req.user, id);
  }

  @Post(':id/acoes/:acao')
  acao(
    @Request() req: RequestSecretaria,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('acao') acao: string,
    @Body() dados: unknown,
  ) {
    const operacao = validar(z.enum(['suspender', 'retomar', 'preparar-encerramento', 'desistir-encerramento']), acao);
    return this.livros.transicao(req.user, id, operacao, dados);
  }

  @Get(':id/complementos/candidatos')
  @Header('Cache-Control', 'private, no-store')
  candidatos(
    @Request() req: RequestSecretaria,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('pagina', new DefaultValuePipe(0), ParseIntPipe) pagina: number,
  ) {
    if (pagina < 0 || pagina > 100000) throw new BadRequestException('Página inválida.');
    return this.livros.candidatosComplemento(req.user, id, pagina);
  }

  @Post(':id/complementos')
  complementar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.livros.complementar(req.user, id, dados);
  }

  @Get(':id/registros/:registro/arquivo')
  async baixarRegistro(
    @Request() req: RequestSecretaria,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('registro', ParseUUIDPipe) registro: string,
    @Res() res: Response,
  ) {
    const bytes = await this.livros.baixarRegistro(req.user, id, registro);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="registro-livro.pdf"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(bytes);
  }

  @Get(':id/arquivos/:tipo')
  async baixar(
    @Request() req: RequestSecretaria,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tipo') tipo: string,
    @Res() res: Response,
  ) {
    const arquivo = validar(z.enum(['historico', 'manifesto', 'compilacao']), tipo);
    const bytes = await this.livros.baixar(req.user, id, arquivo);
    const json = arquivo === 'manifesto';
    res.set({
      'Content-Type': json ? 'application/json' : 'application/pdf',
      'Content-Disposition': `attachment; filename="livro-${arquivo}.${json ? 'json' : 'pdf'}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(bytes);
  }
}
