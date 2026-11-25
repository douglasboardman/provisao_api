import { LiberacoesService } from './liberacoes.service';
import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ContaComum } from './politica';
import { ContasAutorizacaoService } from './contas.service';

@Controller('autorizacao')
@UseGuards(AuthGuard)
export class AutorizacaoController {
  constructor(private readonly contas: ContasAutorizacaoService, private readonly liberacoes: LiberacoesService) {}

  @ContaComum() @Get('me') @Header('Cache-Control', 'private, no-store')
  me(@Request() req) { return this.contas.consultar(req.user); }

  @ContaComum() @Get('navegacao') @Header('Cache-Control', 'private, no-store')
  navegacao(@Request() req) { return this.contas.navegacao(req.user); }

  @Post('contas/:id/conversao/previa')
  previaConversao(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.contas.converter(req.user, id, body, false);
  }

  @Post('contas/:id/conversao')
  converter(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.contas.converter(req.user, id, body, true);
  }

  @Get('contas/:id') @Header('Cache-Control', 'private, no-store')
  consultar(@Request() req, @Param('id', ParseUUIDPipe) id: string) { return this.contas.consultar(req.user, id); }

  @Get('contas/:id/modelos/:modelo') @Header('Cache-Control', 'private, no-store')
  comparar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('modelo', ParseUUIDPipe) modelo: string) {
    return this.contas.compararModelo(req.user, id, modelo);
  }

  @Post('conta-atuacao')
  escolher(@Request() req, @Body() body: unknown) { return this.contas.escolher(req.user, body); }

  @Post('contas/:id/atribuicoes')
  conceder(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) { return this.contas.conceder(req.user, id, body); }

  @Post('atribuicoes/:id/revogar')
  revogar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) { return this.contas.revogar(req.user, id, body); }

  @Post('presidencias/:id/encaminhar')
  encaminhar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) { return this.contas.presidencia(req.user, id, false, body); }

  @Post('presidencias/:id/conferir')
  conferir(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) { return this.contas.presidencia(req.user, id, true, body); }

  @Get('liberacoes') @Header('Cache-Control', 'private, no-store')
  listarLiberacoes(@Request() req) { return this.liberacoes.listar(req.user); }

  @Get('liberacoes/:acao/previa') @Header('Cache-Control', 'private, no-store')
  previaLiberacao(@Request() req, @Param('acao') acao: string) { return this.liberacoes.previa(req.user, acao); }

  @Patch('liberacoes/:acao')
  liberar(@Request() req, @Param('acao') acao: string, @Body() body: unknown) {
    return this.liberacoes.executar(req.user, acao, body);
  }

  @Get('historico') @Header('Cache-Control', 'private, no-store')
  historico(@Request() req, @Query('cursor', new ParseUUIDPipe({ optional: true })) cursor?: string) { return this.contas.historico(req.user, cursor); }
}
