import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { usuarios_perfil as Perfil } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { assertCsrf, sessionCookie } from '../auth/csrf';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { AssinaturasService } from './assinaturas.service';
import { exigirAssinaturas } from './expedicao-estado';
import { ExpedicaoWorkerService } from './expedicao-worker.service';
import type { AtorSecretaria } from './secretaria-base.service';
import { ConsultaContextualAtas, SecretariaGuard } from './secretaria.guard';
import { validar } from './secretaria.dto';

type RequestSecretaria = { user: AtorSecretaria };
const tipos = z.enum(['via', 'final', 'scan', 'manifesto']);
const arquivos = (res: Response, arquivo: { bytes: Buffer; nome: string }) => {
  const ext = arquivo.nome.split('.').at(-1);
  res.set({
    'Content-Type':
      ext === 'pdf' ? 'application/pdf' : ext === 'json' ? 'application/json' : 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${arquivo.nome}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.send(arquivo.bytes);
};

@Controller('secretaria/documentos/:id/assinaturas')
@UseGuards(AuthGuard, RolesGuard, SecretariaGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR)
export class AssinaturasController {
  constructor(private readonly servico: AssinaturasService) {}

  @ConsultaContextualAtas()
  @Get()
  @Header('Cache-Control', 'private, no-store')
  listar(@Req() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) {
    return this.servico.listar(req.user, id);
  }

  @Post(':acao')
  comando(
    @Req() req: RequestSecretaria,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('acao') acao: string,
    @Body() dados: unknown,
  ) {
    exigirAssinaturas();
    switch (validar(z.enum(['convidar', 'revogar', 'via', 'repetir']), acao)) {
      case 'convidar':
        return this.servico.enviarConvite(req.user, id, dados);
      case 'revogar':
        return this.servico.revogar(req.user, id, dados);
      case 'via':
        return this.servico.criarVia(req.user, id, dados);
      case 'repetir':
        return this.servico.repetir(req.user, id, dados);
    }
  }

  @Post('fisica/conferir')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1, fieldSize: 2 * 1024 * 1024 },
    }),
  )
  conferir(
    @Req() req: RequestSecretaria,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('dados') dados: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    exigirAssinaturas();
    let valor: unknown;
    try {
      valor = JSON.parse(dados);
    } catch {
      throw new BadRequestException('Informe os dados da conferência.');
    }
    return this.servico.conferir(req.user, id, valor, file?.buffer);
  }

  @ConsultaContextualAtas()
  @Get(':versao/arquivos/:tipo')
  async baixar(
    @Req() req: RequestSecretaria,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versao', ParseUUIDPipe) versao: string,
    @Param('tipo') tipo: string,
    @Res() res: Response,
  ) {
    arquivos(res, await this.servico.baixar(req.user, id, versao, validar(tipos, tipo)));
  }
}

@Controller('assinaturas')
export class PortalAssinaturasController {
  constructor(
    private readonly servico: AssinaturasService,
    private readonly expedicao: ExpedicaoWorkerService,
    private readonly config: ConfigService,
  ) {}

  private cookie(req: Request) {
    exigirAssinaturas();
    assertCsrf(req, this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001');
    return sessionCookie(req);
  }

  @Post('convite/consulta')
  @Header('Cache-Control', 'private, no-store')
  consultar(@Req() req: Request, @Body() dados: unknown) {
    return this.servico.consultarConvite(dados, this.cookie(req));
  }

  @Post('convite/arquivo')
  async arquivo(@Req() req: Request, @Body() dados: unknown, @Res() res: Response) {
    arquivos(res, await this.servico.arquivoConvite(dados, this.cookie(req)));
  }

  @Post('convite/decisao')
  @Header('Cache-Control', 'private, no-store')
  decidir(@Req() req: Request, @Body() dados: unknown) {
    return this.servico.decidir(dados, this.cookie(req));
  }

  @Get('verificacao/:codigo')
  @Header('Cache-Control', 'no-store')
  verificar(@Param('codigo') codigo: string) {
    return this.expedicao.verificar(codigo);
  }
}
