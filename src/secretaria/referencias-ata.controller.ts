import { ServicoDaRota } from '../autorizacao/politica';
import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { SecretariaGuard } from './secretaria.guard';
import { validar } from './secretaria.dto';
import { alvoAtaSchema, paginaAta } from './referencias-ata.dto';
import { ReferenciasAtaService } from './referencias-ata.service';
import type { AtorSecretaria } from './secretaria-base.service';

type Req = { user: AtorSecretaria };
const pagina = (valor: unknown) => validar(paginaAta, valor);

@Controller('secretaria')
@UseGuards(AuthGuard, RolesGuard, SecretariaGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
export class ReferenciasAtaController {
  constructor(private readonly service: ReferenciasAtaService) {}

  @ServicoDaRota('VINCULOS_DOCUMENTAIS_CONSULTAR')
  @Get('referencias-ata/:grupo/:alvo_id/:etapa')
  @Header('Cache-Control', 'private, no-store')
  consultar(@Request() req: Req, @Param() alvo: unknown, @Query('pagina') p: unknown) {
    return this.service.consultar(req.user, validar(alvoAtaSchema, alvo), pagina(p));
  }

  @ServicoDaRota('VINCULOS_DOCUMENTAIS_REGISTRAR')
  @Post('referencias-ata/:grupo/:alvo_id/:etapa')
  registrar(@Request() req: Req, @Param() alvo: unknown, @Body() dados: unknown) {
    return this.service.registrar(req.user, validar(alvoAtaSchema, alvo), dados);
  }

  @ServicoDaRota('VINCULOS_DOCUMENTAIS_CONSULTAR')
  @Get('referencias-ata/:grupo/:alvo_id/:etapa/atas')
  @Header('Cache-Control', 'private, no-store')
  buscar(@Request() req: Req, @Param() alvo: unknown, @Query() filtros: unknown) {
    return this.service.buscar(req.user, validar(alvoAtaSchema, alvo), filtros);
  }

  @ServicoDaRota('VINCULOS_DOCUMENTAIS_CONSULTAR')
  @Get('documentos/:id/registros-vinculados')
  @Header('Cache-Control', 'private, no-store')
  vinculados(@Request() req: Req, @Param('id', ParseUUIDPipe) id: string, @Query('pagina') p: unknown) {
    return this.service.vinculados(req.user, id, pagina(p));
  }

  @ServicoDaRota('VINCULOS_DOCUMENTAIS_CONSULTAR')
  @Get('documentos/:id/atos-para-reatribuir')
  @Header('Cache-Control', 'private, no-store')
  prepararReatribuicao(@Request() req: Req, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.prepararReatribuicao(req.user, id);
  }

  @ServicoDaRota('VINCULOS_DOCUMENTAIS_CONSULTAR')
  @Get('pendencias-documentais')
  @Header('Cache-Control', 'private, no-store')
  pendencias(@Request() req: Req, @Query() entrada: unknown) {
    const q = validar(z.object({ pagina: paginaAta, grupo: alvoAtaSchema.shape.grupo.optional() }).strict(), entrada);
    return this.service.pendencias(req.user, q.pagina, q.grupo);
  }

  @ServicoDaRota('AUTORIZACOES_FINANCEIRAS_CONSULTAR')
  @Get('autorizacoes-financeiras')
  @Header('Cache-Control', 'private, no-store')
  listarFinanceiro(@Request() req: Req, @Query() entrada: unknown) {
    const q = validar(
      z
        .object({ pagina: paginaAta, projeto: z.string().uuid().optional(), conta: z.string().uuid().optional() })
        .strict(),
      entrada,
    );
    return this.service.listarFinanceiro(req.user, q.pagina, q.projeto, q.conta);
  }

  @ServicoDaRota('AUTORIZACOES_FINANCEIRAS_REGISTRAR')
  @Post('autorizacoes-financeiras')
  registrarFinanceiro(@Request() req: Req, @Body() dados: unknown) {
    return this.service.registrarFinanceiro(req.user, dados);
  }
}
