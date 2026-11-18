import { ManutencaoOrgaoService } from './manutencao-orgao.service';
import { BadRequestException, Body, ConflictException, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { Prisma, usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { OrgaosGuard } from './orgaos.guard';
import { OrgaosGestaoGuard } from './orgaos-gestao.guard';
import { OrgaosOficiaisService } from './orgaos-oficiais.service';
import { UnidadesService } from './unidades.service';
import { PresidenciaService } from './presidencia.service';
import { ConfiguracaoCargosService } from './configuracao-cargos.service';
import { PoliticaUnidadeService } from './politica-unidade.service';
import { ParticipacaoService } from './participacao.service';
import { DesignacoesService } from './designacoes.service';
import { CargosEleitosService } from './cargos-eleitos.service';
import { CargosUnidadeEleitaService } from './cargos-unidade-eleita.service';
import { DesativacaoOrgaoService } from './desativacao-orgao.service';
import { PrismaService } from '../prisma/prisma.service';
import { FusoIgrejaService } from './fuso-igreja.service';
import { DecisaoRevisaoOrgaoService } from './decisao-revisao-orgao.service';

const uuidValido = (valor: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor);

/** A chave de escrita é independente da consulta e permanece fechada por padrão. */
@Controller('orgaos/gestao')
@UseGuards(AuthGuard, RolesGuard, OrgaosGuard, OrgaosGestaoGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
export class OrgaosGestaoController {
  constructor(
    private readonly manutencao: ManutencaoOrgaoService,
    private readonly oficiais: OrgaosOficiaisService,
    private readonly unidades: UnidadesService,
    private readonly presidencias: PresidenciaService,
    private readonly configuracao: ConfiguracaoCargosService,
    private readonly politicas: PoliticaUnidadeService,
    private readonly participacoes: ParticipacaoService,
    private readonly designacoes: DesignacoesService,
    private readonly eleitos: CargosEleitosService,
    private readonly eleitosUnidade: CargosUnidadeEleitaService,
    private readonly desativacao: DesativacaoOrgaoService,
    private readonly prisma: PrismaService,
    private readonly fuso: FusoIgrejaService,
    private readonly decisoes: DecisaoRevisaoOrgaoService,
  ) {}

  private async executar<T>(fn: () => Promise<T>) {
    try { return await fn(); }
    catch (erro) {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003', 'P2004', 'P2010', 'P2034'].includes(erro.code)) throw new ConflictException('O ato conflita com dados existentes ou exige nova conferência.');
      throw erro;
    }
  }

  private async validarCursor(igreja: string, cursor: string | undefined, tipo: 'COMPETENCIA' | 'PRESIDENCIA' | 'DOCENTE') {
    if (!cursor) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)) throw new BadRequestException('Cursor inválido.');
    const existe = tipo === 'COMPETENCIA'
      ? await this.prisma.competencia_unidades.findFirst({ where: { id: cursor, igreja_id: igreja }, select: { id: true } })
      : tipo === 'PRESIDENCIA'
        ? await this.prisma.presidencia_conselho.findFirst({ where: { id: cursor, igreja_id: igreja }, select: { id: true } })
        : await this.prisma.oficial.findFirst({ where: { id: cursor, igreja_id: igreja, tipo: 'PRESBITERO_DOCENTE', pessoa: { sexo: 'MASCULINO' } }, select: { id: true } });
    if (!existe) throw new BadRequestException('Cursor inválido.');
  }

  @Get('fuso') @Roles(Perfil.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  consultarFuso(@Request() req) { return this.fuso.consultar(req.user.igreja_id); }

  @Patch('fuso') @Roles(Perfil.ADMINISTRADOR)
  configurarFuso(@Request() req, @Body() dados: Parameters<FusoIgrejaService['registrar']>[2]) {
    return this.executar(() => this.fuso.registrar(req.user.igreja_id, req.user.sub, dados));
  }

  @Get('pessoas/:pessoa/decisoes-orgaos') @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR)
  @Header('Cache-Control', 'private, no-store')
  decisoesPessoa(@Request() req, @Param('pessoa', ParseUUIDPipe) pessoa: string, @Query('cursor') cursor?: string) {
    return this.decisoes.listar(req.user.igreja_id, req.user.sub, pessoa, cursor);
  }

  @Post('pessoas/:pessoa/previa-vinculos-orgaos') @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR)
  @Header('Cache-Control', 'private, no-store')
  consultarVinculos(@Request() req, @Param('pessoa', ParseUUIDPipe) pessoa: string, @Body() dados: Parameters<DecisaoRevisaoOrgaoService['consultarVinculos']>[3]) {
    return this.executar(() => this.decisoes.consultarVinculos(req.user.igreja_id, req.user.sub, pessoa, dados));
  }

  @Post('pessoas/:pessoa/conferencia-decisoes-orgaos') @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR)
  @Header('Cache-Control', 'private, no-store')
  consolidarDecisoes(@Request() req, @Param('pessoa', ParseUUIDPipe) pessoa: string, @Body() dados: Parameters<DecisaoRevisaoOrgaoService['consolidar']>[3]) {
    return this.executar(() => this.decisoes.consolidar(req.user.igreja_id, req.user.sub, pessoa, dados));
  }

  @Post('pessoas/:pessoa/decisoes-orgaos')
  decisaoPessoa(@Request() req, @Param('pessoa', ParseUUIDPipe) pessoa: string, @Body() dados: Parameters<DecisaoRevisaoOrgaoService['registrar']>[3]) {
    return this.executar(() => this.decisoes.registrar(req.user.igreja_id, req.user.sub, pessoa, dados));
  }

  @Get('competencias') @Roles(Perfil.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  async listarCompetencias(@Request() req, @Query('cursor') cursor?: string) {
    const igreja = req.user.igreja_id;
    await this.validarCursor(igreja, cursor, 'COMPETENCIA');
    const registros = await this.prisma.competencia_unidades.findMany({ where: { igreja_id: igreja }, select: { id: true, inicio: true, fim: true, pessoa: { select: { nome_completo: true } }, usuario: { select: { nome_usuario: true, ativo: true, perfil: true, pessoa_id: true } }, pessoa_id: true }, orderBy: { id: 'asc' }, take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const itens = registros.slice(0, 50);
    return { itens, proximo_cursor: registros.length > 50 ? itens[itens.length - 1].id : null };
  }

  @Get('presidencias') @Roles(Perfil.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  async listarPresidencias(@Request() req, @Query('cursor') cursor?: string) {
    const igreja = req.user.igreja_id;
    await this.validarCursor(igreja, cursor, 'PRESIDENCIA');
    const registros = await this.prisma.presidencia_conselho.findMany({ where: { igreja_id: igreja }, select: { id: true, inicio: true, fim: true, oficial: { select: { id: true, pessoa: { select: { nome_completo: true } } } } }, orderBy: { id: 'asc' }, take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const itens = registros.slice(0, 50);
    return { itens, proximo_cursor: registros.length > 50 ? itens[itens.length - 1].id : null };
  }

  @Get('docentes') @Roles(Perfil.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  async listarDocentes(@Request() req, @Query('cursor') cursor?: string) {
    const igreja = req.user.igreja_id;
    await this.validarCursor(igreja, cursor, 'DOCENTE');
    const registros = await this.prisma.oficial.findMany({ where: { igreja_id: igreja, tipo: 'PRESBITERO_DOCENTE', pessoa: { sexo: 'MASCULINO' } }, select: { id: true, pessoa: { select: { nome_completo: true } } }, orderBy: { id: 'asc' }, take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const itens = registros.slice(0, 50);
    return { itens, proximo_cursor: registros.length > 50 ? itens[itens.length - 1].id : null };
  }

  @Get('eventos-base-membresia')
  @Header('Cache-Control', 'private, no-store')
  async eventosBaseMembresia(@Request() req, @Query('pessoa', ParseUUIDPipe) pessoa: string, @Query('cursor') cursor?: string) {
    const igreja = req.user.igreja_id;
    return this.prisma.$transaction(async tx => {
      if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new BadRequestException('Pessoa não encontrada nesta igreja.');
      if (cursor && (!uuidValido(cursor) || !await tx.eventos_membresia.findFirst({ where: { id: cursor, igreja_id: igreja, pessoa_id: pessoa }, select: { id: true } }))) throw new BadRequestException('Cursor de evento inválido.');
      const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa }, select: { id: true, data_evento: true }, orderBy: [{ data_evento: 'desc' }, { id: 'asc' }], take: 101, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const itens = eventos.slice(0, 100);
      return { itens, limitados: eventos.length > 100, proximo_cursor: eventos.length > 100 ? itens[itens.length - 1].id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  @Get('impactos-membresia')
  @Header('Cache-Control', 'private, no-store')
  async impactosMembresia(@Request() req, @Query('pessoa', ParseUUIDPipe) pessoa: string, @Query('data') dia?: string, @Query('evento') eventoId?: string, @Query('cursor_participacao') cursorParticipacao?: string, @Query('cursor_ocupacao') cursorOcupacao?: string) {
    const dataProposta = dia ? new Date(`${dia}T00:00:00.000Z`) : null;
    if ((!dia && !eventoId) || (dia && (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !Number.isFinite(dataProposta!.getTime()) || dataProposta!.toISOString().slice(0, 10) !== dia))) throw new BadRequestException('Data inválida.');
    if (eventoId && !uuidValido(eventoId)) throw new BadRequestException('Evento inválido.');
    const igreja = req.user.igreja_id;
    return this.prisma.$transaction(async tx => {
      if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new BadRequestException('Pessoa não encontrada nesta igreja.');
      const evento = eventoId ? await tx.eventos_membresia.findFirst({ where: { id: eventoId, igreja_id: igreja, pessoa_id: pessoa }, select: { data_evento: true } }) : null;
      if (eventoId && !evento) throw new BadRequestException('Evento não encontrado para esta pessoa e igreja.');
      const data = evento && dataProposta ? (evento.data_evento < dataProposta ? evento.data_evento : dataProposta) : evento?.data_evento ?? dataProposta!;
      if (cursorParticipacao && (!uuidValido(cursorParticipacao) || !await tx.membro_orgao.findFirst({ where: { id: cursorParticipacao, igreja_id: igreja, pessoa_id: pessoa, inicio: { gte: data } }, select: { id: true } }))) throw new BadRequestException('Cursor de participação inválido.');
      if (cursorOcupacao && (!uuidValido(cursorOcupacao) || !await tx.ocupacao_cargo.findFirst({ where: { id: cursorOcupacao, igreja_id: igreja, pessoa_id: pessoa, inicio: { gte: data } }, select: { id: true } }))) throw new BadRequestException('Cursor de ocupação inválido.');
      const [participacoes, ocupacoes] = await Promise.all([
        tx.membro_orgao.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, inicio: { gte: data } }, select: { id: true, inicio: true, fim: true, orgao: { select: { nome: true } } }, orderBy: [{ inicio: 'asc' }, { id: 'asc' }], take: 101, ...(cursorParticipacao ? { cursor: { id: cursorParticipacao }, skip: 1 } : {}) }),
        tx.ocupacao_cargo.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa, inicio: { gte: data } }, select: { id: true, inicio: true, fim: true, cargo: { select: { nome: true, orgao: { select: { nome: true } } } } }, orderBy: [{ inicio: 'asc' }, { id: 'asc' }], take: 101, ...(cursorOcupacao ? { cursor: { id: cursorOcupacao }, skip: 1 } : {}) }),
      ]);
      const itensParticipacao = participacoes.slice(0, 100), itensOcupacao = ocupacoes.slice(0, 100);
      return { data_inicial: data.toISOString().slice(0, 10), participacoes: itensParticipacao, participacoes_limitadas: participacoes.length > 100, proximo_cursor_participacao: participacoes.length > 100 ? itensParticipacao[itensParticipacao.length - 1].id : null, ocupacoes: itensOcupacao, ocupacoes_limitadas: ocupacoes.length > 100, proximo_cursor_ocupacao: ocupacoes.length > 100 ? itensOcupacao[itensOcupacao.length - 1].id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  @Post('oficiais')
  oficial(@Request() req, @Body() dados: Parameters<OrgaosOficiaisService['registrar']>[2]) {
    return this.executar(() => this.oficiais.registrar(req.user.igreja_id, req.user.sub, dados));
  }

  @Post('unidades') @Roles(Perfil.GESTOR)
  unidade(@Request() req, @Body() dados: Parameters<UnidadesService['criar']>[2]) {
    return this.executar(() => this.unidades.criar(req.user.igreja_id, req.user.sub, dados));
  }

  @Post('competencias') @Roles(Perfil.ADMINISTRADOR)
  competencia(@Request() req, @Body() dados: Parameters<UnidadesService['registrarCompetencia']>[2]) {
    return this.executar(() => this.unidades.registrarCompetencia(req.user.igreja_id, req.user.sub, dados));
  }

  @Patch('competencias/:id/encerrar') @Roles(Perfil.ADMINISTRADOR)
  encerrarCompetencia(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<UnidadesService['encerrarCompetencia']>[3]) {
    return this.executar(() => this.unidades.encerrarCompetencia(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Post('presidencias') @Roles(Perfil.ADMINISTRADOR)
  presidencia(@Request() req, @Body() dados: Parameters<PresidenciaService['registrar']>[2]) {
    return this.executar(() => this.presidencias.registrar(req.user.igreja_id, req.user.sub, dados));
  }

  @Patch('presidencias/:id/encerrar') @Roles(Perfil.ADMINISTRADOR)
  encerrarPresidencia(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<PresidenciaService['encerrar']>[3]) {
    return this.executar(() => this.presidencias.encerrar(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Post(':id/cargos')
  criarCargo(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<ConfiguracaoCargosService['criar']>[3]) {
    return this.executar(() => this.configuracao.criar(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Patch(':id/cargos/:cargo/acumulacao')
  acumulacao(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('cargo', ParseUUIDPipe) cargo: string, @Body() dados: Parameters<ConfiguracaoCargosService['definirAcumulacao']>[4]) {
    return this.executar(() => this.configuracao.definirAcumulacao(req.user.igreja_id, req.user.sub, id, cargo, dados));
  }

  @Post(':id/politicas') @Roles(Perfil.GESTOR)
  politica(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<PoliticaUnidadeService['registrar']>[3]) {
    return this.executar(() => this.politicas.registrar(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Post(':id/participacoes/incluir') @Roles(Perfil.GESTOR)
  incluir(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<ParticipacaoService['alterar']>[4]) {
    return this.executar(() => this.participacoes.alterar(req.user.igreja_id, req.user.sub, id, 'INCLUSAO', dados));
  }

  @Post(':id/participacoes/sair') @Roles(Perfil.GESTOR)
  sair(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<ParticipacaoService['alterar']>[4]) {
    return this.executar(() => this.participacoes.alterar(req.user.igreja_id, req.user.sub, id, 'SAIDA', dados));
  }

  @Post(':id/cargos/:cargo/designacoes') @Roles(Perfil.GESTOR)
  designar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('cargo', ParseUUIDPipe) cargo: string, @Body() dados: Parameters<DesignacoesService['substituir']>[4]) {
    return this.executar(() => this.designacoes.substituir(req.user.igreja_id, req.user.sub, id, cargo, dados));
  }

  @Post(':id/cargos/:cargo/eleicao-oficial')
  eleicaoOficial(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('cargo', ParseUUIDPipe) cargo: string, @Body() dados: Parameters<CargosEleitosService['registrar']>[4]) {
    return this.executar(() => this.eleitos.registrar(req.user.igreja_id, req.user.sub, id, cargo, dados));
  }

  @Post(':id/cargos/:cargo/eleicao-unidade') @Roles(Perfil.GESTOR)
  eleicaoUnidade(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('cargo', ParseUUIDPipe) cargo: string, @Body() dados: Parameters<CargosUnidadeEleitaService['registrar']>[4]) {
    return this.executar(() => this.eleitosUnidade.registrar(req.user.igreja_id, req.user.sub, id, cargo, dados));
  }

  @Patch(':id/ocupacoes/:ocupacao/encerrar-oficial')
  encerrarOficial(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('ocupacao', ParseUUIDPipe) ocupacao: string, @Body() dados: Parameters<CargosEleitosService['encerrar']>[4]) {
    return this.executar(() => this.eleitos.encerrar(req.user.igreja_id, req.user.sub, id, ocupacao, dados));
  }

  @Patch(':id/ocupacoes/:ocupacao/encerrar-unidade') @Roles(Perfil.GESTOR)
  encerrarUnidade(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('ocupacao', ParseUUIDPipe) ocupacao: string, @Body() dados: Parameters<CargosUnidadeEleitaService['encerrar']>[4]) {
    return this.executar(() => this.eleitosUnidade.encerrar(req.user.igreja_id, req.user.sub, id, ocupacao, dados));
  }

  @Patch(':id/cadastro')
  manterCadastro(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<ManutencaoOrgaoService['alterar']>[3]) {
    return this.executar(() => this.manutencao.alterar(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Post(':id/conducoes-reuniao')
  conducao(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<ManutencaoOrgaoService['registrarConducao']>[3]) {
    return this.executar(() => this.manutencao.registrarConducao(req.user.igreja_id, req.user.sub, id, dados));
  }

  @Patch(':id/desativar')
  desativar(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: Parameters<DesativacaoOrgaoService['desativar']>[3]) {
    return this.executar(() => this.desativacao.desativar(req.user.igreja_id, req.user.sub, id, dados));
  }
}
