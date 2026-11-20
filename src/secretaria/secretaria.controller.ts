import { tipoImagemDocumental } from './imagens-documentais';
import { Body, Controller, Get, Header, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Request, Res, UseGuards, DefaultValuePipe, BadRequestException } from '@nestjs/common';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import type { AtorSecretaria } from './secretaria-base.service';
import { SecretariaGuard } from './secretaria.guard';
import { SecretariaCadastrosService } from './secretaria-cadastros.service';
import { DocumentosService } from './documentos.service';
import { PrivateStorageService } from '../private-storage/private-storage.service';
import { RascunhosService } from './rascunhos.service';
import { z } from 'zod';
import { validar } from './secretaria.dto';
import { AtuacaoService } from './atuacao.service';
import { AtasLegadasService } from './atas-legadas.service';

type RequestSecretaria = { user: AtorSecretaria };

@Controller('secretaria')
@UseGuards(AuthGuard, RolesGuard, SecretariaGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR)
export class SecretariaController {
  constructor(readonly cadastros: SecretariaCadastrosService, readonly documentos: DocumentosService, readonly storage: PrivateStorageService, readonly rascunhos: RascunhosService, readonly atuacao: AtuacaoService, readonly atasLegadas: AtasLegadasService) {}
  @Post('atas-legadas')
  criarAtaLegada(@Request() req: RequestSecretaria, @Body() dados: unknown) {
    return this.atasLegadas.criar(req.user, dados);
  }
  @Post('atas-legadas/teor')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  extrairAtaLegada(@Request() req: RequestSecretaria, @Body() dados: unknown) {
    return this.atasLegadas.extrairTeor(req.user, dados);
  }
  @Post('atas-legadas/:id/livro')
  vincularLivroLegado(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.atasLegadas.vincularLivro(req.user, id, dados);
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('atuacao')
  consultarAtuacao(@Request() req: RequestSecretaria, @Query() filtros: unknown) {
    return this.atuacao.consultar(req.user, filtros);
  }

  @Post('atuacao/exportar')
  @HttpCode(200)
  async exportarAtuacao(@Request() req: RequestSecretaria, @Body() filtros: unknown, @Res() res: Response) {
    const csv = await this.atuacao.exportar(req.user, filtros);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="atuacao-secretaria.csv"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    }).send(csv);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get('contextos') contextos(@Request() req: RequestSecretaria) { return this.cadastros.listarContextos(req.user); }
  @Get('contextos/:id/resumo')
  @Header('Cache-Control', 'private, no-store')
  resumo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.cadastros.resumoContexto(req.user, id); }
  @Get('reunioes/:id')
  @Header('Cache-Control', 'private, no-store')
  reuniao(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.cadastros.consultarReuniao(req.user, id); }
  @Post('contextos') criarContexto(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.criarContexto(req.user, b); }
  @Header('Cache-Control', 'private, no-store')
  @Get('competencias') competencias(@Request() req: RequestSecretaria) { return this.cadastros.listarCompetencias(req.user); }
  @Post('competencias') conceder(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.conceder(req.user, b); }
  @Post('competencias/:id/encerrar') encerrar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.encerrarCompetencia(req.user, id, b); }
  @Header('Cache-Control', 'private, no-store')
  @Get('contextos/:id/cargos') cargos(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.cadastros.cargos(req.user, id); }
  @Header('Cache-Control', 'private, no-store')
  @Get('modelos') modelos(@Request() req: RequestSecretaria, @Query('contexto', ParseUUIDPipe) c: string) { return this.cadastros.listarModelos(req.user, c); }
  @Post('modelos') criarModelo(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.criarModelo(req.user, b); }
  @Post('modelos/:id/versoes') versionarModelo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.versionarModelo(req.user, id, b); }
  @Header('Cache-Control', 'private, no-store')
  @Get('reunioes') reunioes(@Request() req: RequestSecretaria, @Query('contexto', ParseUUIDPipe) c: string, @Query('pagina', new DefaultValuePipe(0), ParseIntPipe) p: number) { this.pagina(p); return this.cadastros.listarReunioes(req.user, c, p); }
  @Post('reunioes') criarReuniao(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.criarReuniao(req.user, b); }
  @Patch('reunioes/:id') editarReuniao(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.editarReuniao(req.user, id, b); }
  @Header('Cache-Control', 'private, no-store')
  @Get('documentos') listar(@Request() req: RequestSecretaria, @Query('contexto', ParseUUIDPipe) c: string, @Query('pagina', new DefaultValuePipe(0), ParseIntPipe) p: number) { this.pagina(p); return this.documentos.listar(req.user, c, p); }
  @Post('documentos') criar(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.documentos.criar(req.user, b); }
  @Header('Cache-Control', 'private, no-store')
  @Get('documentos/:id') detalhe(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.documentos.detalhe(req.user, id); }
  @Patch('documentos/:id') editar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.editar(req.user, id, b); }
  @Post('documentos/:id/rascunhos') solicitarRascunho(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.rascunhos.solicitar(req.user, id, validar(z.object({ revisao: z.number().int().positive() }).strict(), b).revisao); }
  @Post('documentos/:id/medicao-livro')
  medir(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.documentos.medir(req.user, id, b);
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('documentos/:id/artefatos')
  listarArtefatos(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) {
    return this.rascunhos.listar(req.user, id);
  }
  @Post('documentos/:id/versoes/:versao/matriz')
  solicitarMatriz(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Param('versao', ParseUUIDPipe) versao: string) {
    return this.rascunhos.solicitarMatriz(req.user, id, versao);
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('documentos/:id/rascunhos/:trabalho') consultarRascunho(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Param('trabalho', ParseUUIDPipe) trabalho: string) { return this.rascunhos.consultar(req.user, id, trabalho); }
  @Get(['documentos/:id/artefatos/:trabalho/arquivo', 'documentos/:id/rascunhos/:trabalho/arquivo'])
  async baixarArtefato(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Param('trabalho', ParseUUIDPipe) trabalho: string, @Res() res: Response) {
    const { bytes, nome } = await this.rascunhos.baixar(req.user, id, trabalho);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${nome}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(bytes);
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('documentos/:id/historico') historico(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Query('pagina', new DefaultValuePipe(0), ParseIntPipe) p: number) { this.pagina(p); return this.documentos.historico(req.user, id, p); }
  @Post('documentos/:id/encaminhar') encaminhar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.executar(req.user, id, 'encaminhar', b); }
  @Post('documentos/:id/aprovar') aprovar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.executar(req.user, id, 'aprovar', b); }
  @Post('documentos/:id/cancelar') cancelar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.executar(req.user, id, 'cancelar', b); }
  @Post('documentos/:id/anular') anular(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.executar(req.user, id, 'anular', b); }
  @Post('documentos/:id/retificar') retificar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.retificar(req.user, id, b); }
  @Post('documentos/:id/deliberar') deliberar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.deliberar(req.user, id, b); }
  @Header('Cache-Control', 'private, no-store')
  @Get('documentos/:id/versoes/:versao/anexos/:arquivo')
  async anexo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Param('versao', ParseUUIDPipe) versao: string, @Param('arquivo', ParseUUIDPipe) arquivo: string, @Res() res: Response, @Query('visualizacao') visualizacao?: string) {
    // A autorização é a do documento, nunca a de um UUID de arquivo isolado.
    const d = await this.documentos.detalhe(req.user, id);
    const anexo = d.versoes.find(v => v.id === versao)?.anexos.find(f => f.arquivo_id === arquivo);
    if (!anexo) throw new BadRequestException('Anexo não pertence à versão.');
    const data = await this.storage.readAuthorized(req.user, { id: arquivo, igreja_id: d.igreja_id, ...anexo.arquivo }, 'anexo_documento_consulta');
    const inline = visualizacao === 'imagem';
    res.set({ 'Content-Type': inline ? tipoImagemDocumental(data).mime : 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(anexo.nome)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(data);
  }
  private pagina(p: number) { if (p < 0 || p > 100000) throw new BadRequestException('Página inválida.'); }
}
