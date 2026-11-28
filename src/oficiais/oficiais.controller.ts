import { estadoDaLiberacao, RotaLegadaDe } from '../autorizacao/liberacao-servico';
import { ContaComum, ServicoDaRota, ServicoEmContexto, contaDaSessao, decidirServico } from '../autorizacao/politica';
import { servicosDeConsulta, servicosDeHistorico } from '../autorizacao/catalogo-servicos';
import { RevisaoEleitoralService } from './revisao-eleitoral.service';
import { InsercaoRetroativaOficialService } from './insercao-retroativa-oficial.service';
import { CorrecaoConteudoService } from './correcao-conteudo.service';
import { InsercaoRetroativaService } from './insercao-retroativa.service';
import { BadRequestException, Body, ConflictException, Controller, Get, GoneException, Header, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { Prisma, usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { GovernancaGuard } from './governanca.guard';
import { AlertasOficiaisService } from './alertas.service';
import { NotificacoesMandatoService } from './notificacoes-mandato.service';
import { IdentidadePastoralService } from './identidade-pastoral.service';
import { OrdenacaoMembresiaService } from './ordenacao-membresia.service';
import { CorrecaoMembresiaService } from './correcao-membresia.service';
import { AcervoHistoricoService } from './acervo-historico.service';
import { AcessoSensivelService } from './acesso-sensivel.service';
import { OficiaisService } from './oficiais.service';
import { MandatoService } from './mandato.service';
import { PoliticaEleicaoService } from '../elegibilidade/politica-eleicao.service';
import { ConferenciaEleicaoService } from '../elegibilidade/conferencia-eleicao.service';
import { SituacaoExercicioService } from './situacao-exercicio.service';
import { AtasEleitoraisService } from './atas-eleitorais.service';

@ServicoDaRota('OFICIAIS_REGISTRAR')
@Controller('oficiais')
@UseGuards(AuthGuard, RolesGuard, GovernancaGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.COMUM)
export class OficiaisController {
  constructor(private readonly revisoesEleitorais: RevisaoEleitoralService, private readonly insercoesOficial: InsercaoRetroativaOficialService, private readonly correcoesConteudo: CorrecaoConteudoService, private readonly insercoesRetroativas: InsercaoRetroativaService, private readonly prisma: PrismaService, private readonly alertas: AlertasOficiaisService, private readonly exercicio: SituacaoExercicioService, private readonly oficiais: OficiaisService, private readonly mandatos: MandatoService, private readonly politicas: PoliticaEleicaoService, private readonly conferencias: ConferenciaEleicaoService, private readonly acessoSensivel: AcessoSensivelService, private readonly acervo: AcervoHistoricoService, private readonly correcoes: CorrecaoMembresiaService, private readonly identidadePastoral: IdentidadePastoralService, private readonly notificacoes: NotificacoesMandatoService, private readonly ordenacoes: OrdenacaoMembresiaService, private readonly atasEleitorais: AtasEleitoraisService) {}

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get()
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  async listar(@Request() req, @Query('cursor') cursor?: string, @Query('tipo') tipo?: string) {
    if (tipo && !['DIACONO', 'PRESBITERO_REGENTE', 'PRESBITERO_DOCENTE'].includes(tipo)) throw new BadRequestException('Tipo de oficial inválido.');
    if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)) throw new BadRequestException('Cursor inválido.');
    if (cursor && !await this.prisma.oficial.findFirst({ where: { id: cursor, igreja_id: req.user.igreja_id }, select: { id: true } })) throw new BadRequestException('Cursor inválido.');
    const rows = await this.prisma.oficial.findMany({ where: { igreja_id: req.user.igreja_id, ...(tipo ? { tipo: tipo as 'DIACONO' | 'PRESBITERO_REGENTE' | 'PRESBITERO_DOCENTE' } : {}) }, select: { id: true, tipo: true, ativo: true, pessoa: { select: { id: true, nome_completo: true } } }, orderBy: { id: 'asc' }, take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const itens = rows.slice(0, 50);
    return { itens, proximo_cursor: rows.length > 50 ? itens[itens.length - 1].id : null };
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get('mandatos-vigentes')
  @Header('Cache-Control', 'private, no-store')
  quadro(@Request() req, @Query('data') referencia: string) {
    const data = new Date(referencia + 'T00:00:00Z');
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== referencia) throw new BadRequestException('Data inválida.');
    return this.prisma.mandato_oficial.findMany({
      where: { igreja_id: req.user.igreja_id, data_posse: { lte: data }, OR: [
        { termino_efetivo: { gte: data } }, { termino_efetivo: null, termino_previsto: { gte: data } },
      ] },
      select: { id: true, data_posse: true, termino_previsto: true, termino_efetivo: true,
        oficial: { select: { tipo: true, pessoa: { select: { nome_completo: true } } } } },
      orderBy: [{ termino_previsto: 'asc' }, { id: 'asc' }],
    });
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get('notificacoes')
  @Header('Cache-Control', 'private, no-store')
  minhasNotificacoes(@Request() req) {
    return this.notificacoes.minhas(req.user.igreja_id, req.user.sub);
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Patch('notificacoes/:id/lida')
  marcarNotificacao(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificacoes.marcarLida(req.user.igreja_id, req.user.sub, id);
  }

  @Get('configuracao-alertas')
  @Roles(Perfil.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  configuracaoAlertas(@Request() req) {
    return this.notificacoes.configuracao(req.user.igreja_id, req.user.sub);
  }

  @Post('configuracao-alertas')
  @Roles(Perfil.ADMINISTRADOR)
  configurarAlertas(@Request() req, @Body() dados: Parameters<NotificacoesMandatoService['configurar']>[2]) {
    return this.comando(() => this.notificacoes.configurar(req.user.igreja_id, req.user.sub, dados));
  }

  @Post('destinatarios-alertas')
  @Roles(Perfil.ADMINISTRADOR)
  adicionarDestinatario(@Request() req, @Body() dados: Parameters<NotificacoesMandatoService['adicionarDestinatario']>[2]) {
    return this.comando(() => this.notificacoes.adicionarDestinatario(req.user.igreja_id, req.user.sub, dados));
  }

  @Patch('destinatarios-alertas/:id/remover')
  @Roles(Perfil.ADMINISTRADOR)
  removerDestinatario(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificacoes.removerDestinatario(req.user.igreja_id, req.user.sub, id);
  }

  @Get('acessos-sensiveis')
  @Roles(Perfil.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  listarAcessos(@Request() req) {
    return this.prisma.acesso_eventos_sensiveis.findMany({ where: { igreja_id: req.user.igreja_id }, select: { id: true, usuario_id: true, pode_consultar: true, pode_registrar: true, fundamento: true, concedido_em: true, revogado_em: true, usuario: { select: { nome_usuario: true } } }, orderBy: [{ concedido_em: 'desc' }, { id: 'asc' }], take: 100 });
  }

  @Get('meu-acesso-sensivel')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  async meuAcesso(@Request() req) {
    return this.prisma.$transaction(async tx => {
      const conta = await contaDaSessao(tx, req.user);
      const acesso = await tx.acesso_eventos_sensiveis.findFirst({ where: { igreja_id: conta.igreja_id, usuario_id: conta.id, revogado_em: null },
        select: { pode_consultar: true, pode_registrar: true } });
      const operacoes = Object.fromEntries(await Promise.all(servicosDeHistorico.map(async acao => {
        const estado = await estadoDaLiberacao(tx, conta.igreja_id, acao);
        const permite = estado !== 'PAUSADO' && (await decidirServico(tx, conta, acao)).permite;
        return [acao, permite] as const;
      })));
      return { pode_consultar: !!acesso?.pode_consultar,
        pode_registrar: conta.perfil !== Perfil.AUDITOR && !!acesso?.pode_registrar, operacoes };
    }, { isolationLevel: 'RepeatableRead' });
  }

  @ServicoDaRota('HISTORICO_OFICIAIS_CONSULTAR')
  @Get(':id/insercoes-retroativas')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  insercoesRetroativasOficial(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.insercoesOficial.listar(req.user.igreja_id, req.user.sub, id, req.user);
  }
  @ServicoDaRota('HISTORICO_OFICIAIS_CONSULTAR')
  @Post(':id/insercoes-retroativas/previa')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  previaInsercaoOficial(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<InsercaoRetroativaOficialService['previa']>[3]) {
    return this.comando(() => this.insercoesOficial.previa(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }
  @ServicoDaRota('HISTORICO_OFICIAIS_REGISTRAR')
  @Post(':id/insercoes-retroativas/aplicar')
  aplicarInsercaoOficial(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<InsercaoRetroativaOficialService['aplicar']>[3]) {
    return this.comando(() => this.insercoesOficial.aplicar(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }

  @ServicoDaRota('HISTORICO_OFICIAIS_CONSULTAR')
  @Get(':id/eventos-sensiveis')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  eventosSensiveis(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.acessoSensivel.consultarEventos(req.user.igreja_id, req.user.sub, id);
  }

  @Post('acessos-sensiveis')
  @Roles(Perfil.ADMINISTRADOR)
  concederAcesso(@Request() req, @Body() dados: Parameters<AcessoSensivelService['conceder']>[2]) {
    return this.comando(() => this.acessoSensivel.conceder(req.user.igreja_id, req.user.sub, dados));
  }

  @Patch('acessos-sensiveis/:id/revogar')
  @Roles(Perfil.ADMINISTRADOR)
  revogarAcesso(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<AcessoSensivelService['revogar']>[3]) {
    return this.comando(() => this.acessoSensivel.revogar(req.user.igreja_id, req.user.sub, id, dados));
  }

  @ServicoDaRota('REVISOES_ELEITORAIS_DECIDIR')
  @Post('revisoes-eleitorais/:id/concluir')
  concluirRevisaoEleitoral(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<RevisaoEleitoralService['concluir']>[3]) {
    return this.comando(() => this.revisoesEleitorais.concluir(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get('pessoas/:id/revisoes-eleitorais')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  revisoesEleitoraisPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.revisoesEleitorais.listar(req.user.igreja_id, req.user.sub, id, req.user);
  }
  @ServicoDaRota('REVISOES_ELEITORAIS_DECIDIR')
  @Post('pessoas/:id/revisoes-eleitorais')
  registrarRevisaoEleitoral(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<RevisaoEleitoralService['registrar']>[3]) {
    return this.comando(() => this.revisoesEleitorais.registrar(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get('pessoas/:id/correcoes-conteudo')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  correcoesConteudoPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.correcoesConteudo.listar(req.user.igreja_id, req.user.sub, id, req.user);
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Post('pessoas/:id/correcoes-conteudo/previa')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  previaConteudoPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<CorrecaoConteudoService['previa']>[3]) {
    return this.comando(() => this.correcoesConteudo.previa(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_RETIFICAR')
  @Post('pessoas/:id/correcoes-conteudo/aplicar')
  aplicarConteudoPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<CorrecaoConteudoService['aplicar']>[3]) {
    return this.comando(() => this.correcoesConteudo.aplicar(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get('pessoas/:id/insercoes-retroativas')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  insercoesPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.insercoesRetroativas.listar(req.user.igreja_id, req.user.sub, id, req.user);
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Post('pessoas/:id/insercoes-retroativas/previa')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  previaInsercaoPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<InsercaoRetroativaService['previa']>[3]) {
    return this.comando(() => this.insercoesRetroativas.previa(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_RETIFICAR')
  @Post('pessoas/:id/insercoes-retroativas/aplicar')
  aplicarInsercaoPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<InsercaoRetroativaService['aplicar']>[3]) {
    return this.comando(() => this.insercoesRetroativas.aplicar(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get('pessoas/:id/correcoes-data')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  correcoesPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.correcoes.listarCorrecoes(req.user.igreja_id, req.user.sub, id, true, req.user);
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Post('pessoas/:id/correcoes-data/previa')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  previaCorrecaoPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<CorrecaoMembresiaService['previa']>[3]) {
    return this.comando(() => this.correcoes.previa(req.user.igreja_id, req.user.sub, id, dados, true, req.user));
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_RETIFICAR')
  @Post('pessoas/:id/correcoes-data/aplicar')
  aplicarCorrecaoPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<CorrecaoMembresiaService['aplicar']>[3]) {
    return this.comando(() => this.correcoes.aplicar(req.user.igreja_id, req.user.sub, id, dados, true, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get('pessoas/:id/eventos-para-ordem')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  eventosPessoaParaOrdem(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordenacoes.eventosPessoa(req.user.igreja_id, req.user.sub, id, req.user);
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get('pessoas/:id/ordenacoes-dia')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  ordenacoesPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordenacoes.listar(req.user.igreja_id, req.user.sub, id, true, req.user);
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Post('pessoas/:id/ordenacoes-dia/previa')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  previaOrdemPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OrdenacaoMembresiaService['previa']>[3]) {
    return this.comando(() => this.ordenacoes.previa(req.user.igreja_id, req.user.sub, id, dados, true, req.user));
  }
  @ServicoDaRota('HISTORICO_MEMBRESIA_RETIFICAR')
  @Post('pessoas/:id/ordenacoes-dia/aplicar')
  aplicarOrdemPessoa(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OrdenacaoMembresiaService['aplicar']>[3]) {
    return this.comando(() => this.ordenacoes.aplicar(req.user.igreja_id, req.user.sub, id, dados, true, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get(':id/ordenacoes-dia')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  listarOrdenacoes(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordenacoes.listar(req.user.igreja_id, req.user.sub, id, false, req.user);
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Post(':id/ordenacoes-dia/previa')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  previaOrdenacao(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OrdenacaoMembresiaService['previa']>[3]) {
    return this.comando(() => this.ordenacoes.previa(req.user.igreja_id, req.user.sub, id, dados, false, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_RETIFICAR')
  @Post(':id/ordenacoes-dia/aplicar')
  aplicarOrdenacao(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OrdenacaoMembresiaService['aplicar']>[3]) {
    return this.comando(() => this.ordenacoes.aplicar(req.user.igreja_id, req.user.sub, id, dados, false, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get(':id/membresia-para-correcao')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  eventosParaCorrecao(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.correcoes.listarEventos(req.user.igreja_id, req.user.sub, id, req.user);
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Get(':id/correcoes-data')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  correcoesRegistradas(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.correcoes.listarCorrecoes(req.user.igreja_id, req.user.sub, id, false, req.user);
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_CONSULTAR')
  @Post(':id/correcoes-data/previa')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  previaCorrecao(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<CorrecaoMembresiaService['previa']>[3]) {
    return this.comando(() => this.correcoes.previa(req.user.igreja_id, req.user.sub, id, dados, false, req.user));
  }

  @ServicoDaRota('HISTORICO_MEMBRESIA_RETIFICAR')
  @Post(':id/correcoes-data/aplicar')
  aplicarCorrecao(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<CorrecaoMembresiaService['aplicar']>[3]) {
    return this.comando(() => this.correcoes.aplicar(req.user.igreja_id, req.user.sub, id, dados, false, req.user));
  }

  @Get(':id/identidade-pastoral')
  @Header('Cache-Control', 'private, no-store')
  identidadeLocal(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.identidadePastoral.local(req.user.igreja_id, req.user.sub, id);
  }

  @Post(':id/identidade-pastoral/convites')
  @Header('Cache-Control', 'private, no-store')
  convidarIdentidade(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<IdentidadePastoralService['convidar']>[3]) {
    return this.comando(() => this.identidadePastoral.convidar(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Post(':id/identidade-pastoral/receber')
  @Header('Cache-Control', 'private, no-store')
  receberIdentidade(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<IdentidadePastoralService['receber']>[3]) {
    return this.comando(() => this.identidadePastoral.receber(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Patch(':id/identidade-pastoral/revogar')
  revogarIdentidade(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<IdentidadePastoralService['revogar']>[3]) {
    return this.comando(() => this.identidadePastoral.revogar(req.user.igreja_id, req.user.sub, id, dados));
  }

  @ServicoDaRota('HISTORICO_OFICIAIS_CONSULTAR')
  @Get(':id/acervo-historico')
  @Header('Cache-Control', 'private, no-store')
  listarAcervo(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.acervo.listar(req.user.igreja_id, id);
  }

  @ServicoDaRota('HISTORICO_OFICIAIS_CONSULTAR')
  @Get('acervo-historico/:id/detalhe')
  @Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  detalheAcervo(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.acervo.detalhe(req.user.igreja_id, req.user.sub, id, req.user);
  }

  @ServicoDaRota('HISTORICO_OFICIAIS_REGISTRAR')
  @Post(':id/acervo-historico')
  registrarAcervo(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<AcervoHistoricoService['registrar']>[3]) {
    return this.comando(() => this.acervo.registrar(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get('politicas')
  @Header('Cache-Control', 'private, no-store')
  listarPoliticas(@Request() req) {
    return this.prisma.politica_eleicao_oficial.findMany({ where: { igreja_id: req.user.igreja_id }, select: { id: true, versao: true, fonte: true, vigente_desde: true, vigente_ate: true }, orderBy: [{ vigente_desde: 'desc' }, { id: 'asc' }] });
  }

  @Get('indicacoes/selecao-atas')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  selecionarAtas(@Request() req, @Query() consulta: Record<string, string>) {
    const { tipo, ...filtros } = consulta;
    return this.atasEleitorais.selecionarAtas(req.user, tipo, filtros);
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get('indicacoes/atas')
  @Header('Cache-Control', 'private, no-store')
  atasDeEleicao(@Request() req, @Query('tipo') tipo: string, @Query('busca') busca?: string) {
    return this.atasEleitorais.listarAtas(req.user, tipo, busca);
  }

  @Get('indicacoes/candidatos')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  candidatosDeEleicao(@Request() req, @Query('ata') ata: string, @Query('busca') busca?: string, @Query('tipo') tipo?: string) {
    return this.atasEleitorais.candidatos(req.user, ata, busca, tipo);
  }

  @Post('indicacoes/mandatos')
  mandatoPorIndicacaoRetirado() {
    throw new GoneException('Registre o mandato na ficha do Conselho ou da Junta.');
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get('conferencias/:pessoaId')
  @Header('Cache-Control', 'private, no-store')
  async listarConferencias(@Request() req, @Param('pessoaId', ParseUUIDPipe) pessoaId: string) {
    const pessoa = await this.prisma.pessoas.findFirst({ where: { id: pessoaId, igreja_id: req.user.igreja_id }, select: { id: true } });
    if (!pessoa) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
    const conferencias = await this.prisma.conferencia_eleicao_oficial.findMany({ where: { igreja_id: req.user.igreja_id, pessoa_id: pessoaId }, select: { id: true, data_eleicao: true, politica_id: true, mandato: { select: { id: true } }, revisoes_pendentes: { where: { OR: [{ revisado_em: null }, { permite_reutilizacao: false }] }, select: { revisado_em: true } } }, orderBy: [{ data_eleicao: 'desc' }, { id: 'asc' }] });
    return conferencias.map(({ revisoes_pendentes, ...c }) => ({ ...c, revisao_pendente: revisoes_pendentes.some(r => r.revisado_em === null), impedida_para_mandato: revisoes_pendentes.length > 0 }));
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get(':id/periodos')
  @Header('Cache-Control', 'private, no-store')
  async listarPeriodos(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    const oficial = await this.prisma.oficial.findFirst({ where: { id, igreja_id: req.user.igreja_id }, select: { id: true } });
    if (!oficial) throw new NotFoundException('Oficial não encontrado nesta igreja.');
    const [mandatos, vinculos] = await Promise.all([
      this.prisma.mandato_oficial.findMany({ where: { igreja_id: req.user.igreja_id, oficial_id: id }, select: { id: true, data_eleicao: true, data_posse: true, termino_previsto: true, termino_efetivo: true, revisoes_pendentes: { where: { revisado_em: null }, select: { id: true }, take: 1 } }, orderBy: { data_posse: 'desc' } }),
      this.prisma.vinculo_pastoral.findMany({ where: { igreja_id: req.user.igreja_id, oficial_id: id }, select: { id: true, modalidade: true, concilio: true, data_inicio: true, data_fim: true, exercicio_institucional: true }, orderBy: { data_inicio: 'desc' } }),
    ]);
    return { mandatos: mandatos.map(({ revisoes_pendentes, ...m }) => ({ ...m, revisao_pendente: revisoes_pendentes.length > 0 })), vinculos };
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get('alertas')
  @Header('Cache-Control', 'private, no-store')
  async consultarAlertas(@Request() req, @Query('data') data: string, @Query('dias') dias: string) {
    if (!/^\d{1,3}$/.test(dias ?? '')) throw new BadRequestException('Período inválido.');
    return this.alertas.mandatos(req.user.igreja_id, req.user.sub, data, Number(dias));
  }

  @ServicoDaRota('OFICIAIS_CONSULTAR')
  @Get(':id/exercicio')
  @Header('Cache-Control', 'private, no-store')
  async consultarExercicio(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Query('data') data: string) {
    const resultado = await this.exercicio.consultar(req.user.igreja_id, req.user.sub, id, data);
    // A razão pode conter informação disciplinar; não divulgar sem política específica de sigilo.
    return { situacao: resultado.situacao, data_referencia: resultado.data_referencia, revisao_pendente: 'revisao_pendente' in resultado && resultado.revisao_pendente === true };
  }

  private async comando<T>(operacao: () => Promise<T>): Promise<T> {
    try { return await operacao(); }
    catch (erro) {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003', 'P2004'].includes(erro.code)) throw new ConflictException('O registro conflita com dados existentes ou com restrições de integridade.');
      throw erro;
    }
  }

  @Post()
  cadastrar(@Request() req, @Body() dados: Parameters<OficiaisService['cadastrar']>[2]) {
    return this.comando(() => this.oficiais.cadastrar(req.user.igreja_id, req.user.sub, dados));
  }

  @Patch(':id/situacao')
  alterarSituacao(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OficiaisService['alterarSituacao']>[3]) {
    return this.comando(() => this.oficiais.alterarSituacao(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Post('politicas')
  @Roles(Perfil.ADMINISTRADOR)
  politica(@Request() req, @Body() dados: Parameters<PoliticaEleicaoService['registrar']>[2]) {
    return this.comando(() => this.politicas.registrar(req.user.igreja_id, req.user.sub, dados));
  }

  @Post('conferencias')
  conferencia(@Request() req, @Body() dados: Parameters<ConferenciaEleicaoService['registrar']>[2]) {
    return this.comando(() => this.conferencias.registrar(req.user.igreja_id, req.user.sub, dados));
  }

  @ServicoDaRota('HISTORICO_OFICIAIS_REGISTRAR')
  @Post(':id/eventos')
  evento(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OficiaisService['registrarEvento']>[3]) {
    return this.comando(() => this.oficiais.registrarEvento(req.user.igreja_id, req.user.sub, id, dados, dados?.tipo !== 'ORDENACAO', req.user));
  }

  @Post(':id/mandatos')
  @RotaLegadaDe('MANDATOS_REGISTRAR')
  mandato(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<MandatoService['registrar']>[3]) {
    return this.comando(() => this.mandatos.registrar(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Post(':id/vinculos-pastorais')
  vinculo(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OficiaisService['registrarVinculoPastoral']>[3]) {
    return this.comando(() => this.oficiais.registrarVinculoPastoral(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Patch('mandatos/:id/encerrar')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.COMUM)
  @ServicoEmContexto('MANDATOS_REGISTRAR')
  encerrarMandato(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<MandatoService['encerrar']>[3]) {
    return this.comando(() => this.mandatos.encerrar(req.user.igreja_id, req.user.sub, id, dados, req.user));
  }

  @Patch('vinculos-pastorais/:id/encerrar')
  encerrarVinculo(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<OficiaisService['encerrarVinculoPastoral']>[3]) {
    return this.comando(() => this.oficiais.encerrarVinculoPastoral(req.user.igreja_id, req.user.sub, id, dados));
  }

}
