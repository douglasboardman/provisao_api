import { ContaComum } from '../autorizacao/politica';
import { tipoImagemDocumental } from './imagens-documentais';
import { Body, Controller, Get, Header, HttpCode, UploadedFile, UseInterceptors, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Request, Res, UseGuards, DefaultValuePipe, BadRequestException } from '@nestjs/common';
import { usuarios_perfil as Perfil } from '@prisma/client';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import type { AtorSecretaria } from './secretaria-base.service';
import { OperacaoContextual, SecretariaGuard } from './secretaria.guard';
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
  @Post('imagens')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  enviarImagem(@Request() req: RequestSecretaria, @Body('idempotencia', ParseUUIDPipe) chave: string, @UploadedFile() arquivo?: Express.Multer.File) {
    if (!arquivo?.buffer?.length) throw new BadRequestException('Imagem obrigatória.');
    tipoImagemDocumental(arquivo.buffer);
    return this.cadastros.enviarImagem(req.user, arquivo.buffer, chave);
  }

  @Get('logo-da-igreja')
  async logoDaIgreja(@Request() req: RequestSecretaria, @Res() res: Response) {
    const bytes = await this.cadastros.logoDaIgreja(req.user);
    res.set({ 'Content-Type': tipoImagemDocumental(bytes).mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(bytes);
  }
  @Get('campos')
  @Header('Cache-Control', 'private, no-store')
  campos(@Request() req: RequestSecretaria) { return this.cadastros.listarCampos(req.user); }

  @Post('campos')
  @Roles(Perfil.ADMINISTRADOR, Perfil.SECRETARIO)
  criarCampo(@Request() req: RequestSecretaria, @Body() dados: unknown) { return this.cadastros.salvarCampo(req.user, dados); }

  @Patch('campos/:id')
  @Roles(Perfil.ADMINISTRADOR, Perfil.SECRETARIO)
  editarCampo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) { return this.cadastros.salvarCampo(req.user, dados, id); }

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
  @Patch('atas-legadas/:id')
  editarAtaLegada(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.atasLegadas.editar(req.user, id, dados);
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
  @OperacaoContextual()
  @Get('contextos') contextos(@Request() req: RequestSecretaria) { return this.cadastros.listarContextos(req.user); }
  @OperacaoContextual()
  @Get('contextos/:id/resumo')
  @Header('Cache-Control', 'private, no-store')
  resumo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.cadastros.resumoContexto(req.user, id); }
  @Get('locais') locais(@Request() req: RequestSecretaria) { return this.cadastros.listarLocais(req.user); }
  @Post('locais') criarLocal(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.salvarLocal(req.user, b); }
  @Patch('locais/:id') editarLocal(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.salvarLocal(req.user, b, id); }
  @OperacaoContextual()
  @Get('reunioes/:id')
  @Header('Cache-Control', 'private, no-store')
  reuniao(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.cadastros.consultarReuniao(req.user, id); }
  @Post('contextos') criarContexto(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.criarContexto(req.user, b); }
  @Header('Cache-Control', 'private, no-store')
  @Get('competencias') competencias(@Request() req: RequestSecretaria) { return this.cadastros.listarCompetencias(req.user); }
  @Post('competencias') conceder(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.conceder(req.user, b); }
  @Post('competencias/:id/encerrar') encerrar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.encerrarCompetencia(req.user, id, b); }
  @Header('Cache-Control', 'private, no-store')
  @Get('contextos/:id/papeis-modelo') papeisModelo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.cadastros.opcoesAtuacao(req.user, id); }
  @ContaComum()
  @Roles(Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  @Get('contextos/:id/pessoas')
  pessoasDoContexto(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) {
    return this.cadastros.pessoasDoContexto(req.user, id);
  }
  @OperacaoContextual()
  @Get('contextos/:id/cargos') cargos(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.cadastros.cargos(req.user, id); }
  @Header('Cache-Control', 'private, no-store')
  @OperacaoContextual()
  @Get('modelos') modelos(@Request() req: RequestSecretaria, @Query('contexto', ParseUUIDPipe) c: string) { return this.cadastros.listarModelos(req.user, c); }
  @OperacaoContextual()
  @Get('modelos/versoes/:versao/imagens/:arquivo')
  async imagemModelo(@Request() req: RequestSecretaria, @Param('versao', ParseUUIDPipe) versao: string, @Param('arquivo', ParseUUIDPipe) arquivo: string, @Res() res: Response) {
    const bytes = await this.cadastros.imagemModelo(req.user, versao, arquivo);
    res.set({ 'Content-Type': tipoImagemDocumental(bytes).mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(bytes);
  }
  @Post('modelos') criarModelo(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.criarModelo(req.user, b); }
  @Post('modelos/:id/versoes') versionarModelo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.salvarModelo(req.user, id, b, 'versionar'); }
  @Post('modelos/:id/editar') editarModelo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.iniciarEdicaoModelo(req.user, id, b); }
  @Patch('modelos/:id/rascunho') salvarRascunhoModelo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.salvarModelo(req.user, id, b, 'rascunho'); }
  @Post('modelos/:id/publicar') publicarModelo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.salvarModelo(req.user, id, b, 'publicar'); }
  @Get('modelos/:id/rascunho/imagens/:arquivo')
  async imagemRascunhoModelo(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Param('arquivo', ParseUUIDPipe) arquivo: string, @Res() res: Response) {
    const bytes = await this.cadastros.imagemModelo(req.user, id, arquivo, true);
    res.set({ 'Content-Type': tipoImagemDocumental(bytes).mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(bytes);
  }
  @Header('Cache-Control', 'private, no-store')
  @OperacaoContextual()
  @Get('reunioes') reunioes(@Request() req: RequestSecretaria, @Query('contexto', ParseUUIDPipe) c: string, @Query('pagina', new DefaultValuePipe(0), ParseIntPipe) p: number) { this.pagina(p); return this.cadastros.listarReunioes(req.user, c, p); }
  @Post('reunioes') criarReuniao(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.cadastros.criarReuniao(req.user, b); }
  @Patch('reunioes/:id') editarReuniao(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.cadastros.editarReuniao(req.user, id, b); }
  @Header('Cache-Control', 'private, no-store')
  @Post('antecedentes/previa')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  previaOrigem(@Request() req: RequestSecretaria, @Body() dados: unknown) { return this.documentos.previaOrigem(req.user, dados); }

  @Get('motivadores')
  @Header('Cache-Control', 'private, no-store')
  motivadores(@Request() req: RequestSecretaria, @Query() filtros: Record<string, string>) {
    return this.documentos.motivadores(req.user, filtros);
  }
  @OperacaoContextual()
  @Get('documentos/consulta')
  @Header('Cache-Control', 'private, no-store')
  consultarDocumentos(@Request() req: RequestSecretaria, @Query() parametros: unknown) { return this.documentos.consultar(req.user, parametros); }
  @OperacaoContextual()
  @Get('documentos') listar(@Request() req: RequestSecretaria, @Query('contexto', ParseUUIDPipe) c: string, @Query('pagina', new DefaultValuePipe(0), ParseIntPipe) p: number) { this.pagina(p); return this.documentos.listar(req.user, c, p); }
  @OperacaoContextual()
  @Post('livros/:id/previa-abertura')
  previaAbertura(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) { return this.documentos.previaTermo(req.user, id, dados, 'TERMO_ABERTURA'); }
  @OperacaoContextual()
  @Post('livros/:id/previa-encerramento')
  previaEncerramento(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) { return this.documentos.previaTermo(req.user, id, dados, 'TERMO_ENCERRAMENTO'); }
  @OperacaoContextual()
  @Post('documentos') criar(@Request() req: RequestSecretaria, @Body() b: unknown) { return this.documentos.criar(req.user, b); }
  @Header('Cache-Control', 'private, no-store')
  @OperacaoContextual()
  @Get('documentos/:id') detalhe(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) { return this.documentos.detalhe(req.user, id); }
  @OperacaoContextual()
  @Patch('documentos/:id') editar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.editar(req.user, id, b); }
  @OperacaoContextual()
  @Post('documentos/:id/previa-fontes') previaFontes(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.previaFontes(req.user, id, b); }
  @OperacaoContextual()
  @Post('documentos/:id/rascunhos') solicitarRascunho(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.rascunhos.solicitar(req.user, id, validar(z.object({ revisao: z.number().int().positive() }).strict(), b).revisao); }
  @Post('documentos/:id/medicao-livro')
  medir(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.documentos.medir(req.user, id, b);
  }
  @Header('Cache-Control', 'private, no-store')
  @OperacaoContextual()
  @Get('documentos/:id/artefatos')
  listarArtefatos(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string) {
    return this.rascunhos.listar(req.user, id);
  }
  @Post('documentos/:id/versoes/:versao/matriz')
  solicitarMatriz(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Param('versao', ParseUUIDPipe) versao: string) {
    return this.rascunhos.solicitarMatriz(req.user, id, versao);
  }
  @Header('Cache-Control', 'private, no-store')
  @OperacaoContextual()
  @Get('documentos/:id/rascunhos/:trabalho') consultarRascunho(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Param('trabalho', ParseUUIDPipe) trabalho: string) { return this.rascunhos.consultar(req.user, id, trabalho); }
  @OperacaoContextual()
  @Get(['documentos/:id/artefatos/:trabalho/arquivo', 'documentos/:id/rascunhos/:trabalho/arquivo'])
  async baixarArtefato(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Param('trabalho', ParseUUIDPipe) trabalho: string, @Res() res: Response) {
    const { bytes, nome } = await this.rascunhos.baixar(req.user, id, trabalho);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${nome}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(bytes);
  }
  @Header('Cache-Control', 'private, no-store')
  @OperacaoContextual()
  @Get('documentos/:id/historico') historico(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Query('pagina', new DefaultValuePipe(0), ParseIntPipe) p: number) { this.pagina(p); return this.documentos.historico(req.user, id, p); }
  @OperacaoContextual()
  @Post('documentos/:id/encaminhar') encaminhar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.executar(req.user, id, 'encaminhar', b); }
  @OperacaoContextual()
  @Post('documentos/:id/aprovar') aprovar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.executar(req.user, id, 'aprovar', b); }
  @Post('documentos/:id/cancelar') cancelar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.executar(req.user, id, 'cancelar', b); }
  @Post('documentos/:id/anular') anular(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.executar(req.user, id, 'anular', b); }
  @Post('documentos/:id/retificar') retificar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.retificar(req.user, id, b); }
  @OperacaoContextual()
  @Post('documentos/:id/deliberar') deliberar(@Request() req: RequestSecretaria, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.documentos.deliberar(req.user, id, b); }
  @Header('Cache-Control', 'private, no-store')
  @OperacaoContextual()
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
