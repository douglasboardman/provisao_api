import { AtuacaoModeloService } from '../secretaria/atuacao-modelo.service';
import { orgaosDeAtuacao, orgaosOficiaisDaConta, presidenciaSociedades } from './acesso-sociedades';
import { cabeNaFaixa, configuracaoOrgao, diaCivilOrgao, faixaCivil, regrasSociedade, sociedadeJuvenil } from './sociedades-regras';
import { ContaComum, ServicoDaRota, ServicoEmContexto, contaDaSessao, decidirServico } from '../autorizacao/politica';
import { z } from 'zod';
import { MandatoDiretoService } from './mandato-direto.service';
import { permissaoMandato } from './permissao-mandato';
import { estadoDaLiberacao } from '../autorizacao/liberacao-servico';
import { recursoDaIgreja } from '../feature-flags/feature-flags';
import { tiposOrdenados } from './ordem-ato';
import { BadRequestException, Body, Controller, Post, Get, Header, NotFoundException, Param, ParseUUIDPipe, Query, Request, UseGuards } from '@nestjs/common';
import { Prisma, usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { ComposicaoService } from './composicao.service';
import { OrgaosGuard } from './orgaos.guard';
import { dataCivilNoFuso, hojeDaIgreja } from './relogio-igreja';

const contextoComCargos = (tipo: string) => tipo === 'CONSELHO' || tipo === 'JUNTA';

@Controller('orgaos')
@UseGuards(AuthGuard, RolesGuard, OrgaosGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR)
export class OrgaosController {
  constructor(private readonly prisma: PrismaService, private readonly composicao: ComposicaoService, private readonly mandatos: MandatoDiretoService, private readonly atuacao: AtuacaoModeloService) {}

  private async vigenteNaData(tx: Prisma.TransactionClient, igreja_id: string, orgao: { id: string; ativo: boolean; tipo: string; tipo_padrao: string | null; criado_em: Date; data_criacao: Date | null }, data: Date) {
    if (orgao.tipo === 'SOCIEDADE_INTERNA') {
      const atos = await tx.ato_orgao.findMany({ where: { igreja_id, orgao_id: orgao.id, tipo: { in: ['ATIVACAO_SOCIEDADE', 'DESATIVACAO'] } },
        select: { tipo: true, data_efeito: true, detalhes: true }, orderBy: [{ data_efeito: 'desc' }, { criado_em: 'desc' }] });
      const dia = diaCivilOrgao(data);
      return atos.find(ato => {
        const inicio = configuracaoOrgao(ato.detalhes).inicio_atividade;
        return (typeof inicio === 'string' ? inicio : diaCivilOrgao(ato.data_efeito)) <= dia;
      })?.tipo === 'ATIVACAO_SOCIEDADE';
    }
    if (!orgao.ativo) {
      const fim = await tx.ato_orgao.findFirst({ where: { igreja_id, orgao_id: orgao.id, tipo: 'DESATIVACAO' }, select: { data_efeito: true }, orderBy: { data_efeito: 'desc' } });
      if (!fim || fim.data_efeito <= data) return false;
    }
    if (orgao.data_criacao) return orgao.data_criacao <= data;
    if (orgao.criado_em.toISOString().slice(0,10) <= data.toISOString().slice(0,10)) return true;
    if (!['CONSELHO','JUNTA'].includes(orgao.tipo) || orgao.tipo_padrao !== orgao.tipo) return false;
    // Um período documentado comprova atividade anterior à instalação do catálogo, sem atribuir data de fundação.
    if (await tx.mandato_oficial.findFirst({ where: { igreja_id, data_posse: { lte: data }, oficial: { tipo: orgao.tipo === 'JUNTA' ? 'DIACONO' : 'PRESBITERO_REGENTE' },
      OR: [{ orgao_id: null }, { orgao_id: orgao.id }] }, select: { id: true } })) return true;
    return orgao.tipo === 'CONSELHO' && !!await tx.vinculo_pastoral.findFirst({ where: { igreja_id, exercicio_institucional: true,
      oficial: { tipo: 'PRESBITERO_DOCENTE' }, data_inicio: { lte: data } }, select: { id: true } });
  }

  private async acessoInstitucional(tx: Prisma.TransactionClient, req) {
    const conta = await contaDaSessao(tx, req.user);
    const dia = await hojeDaIgreja(tx, conta.igreja_id);
    const poder = await presidenciaSociedades(tx, conta, dia);
    const geral = conta.perfil === 'COMUM' && (await Promise.all((['ORGAOS_CONSULTAR','MANDATOS_REGISTRAR','CARGOS_REGISTRAR'] as const)
      .map(acao => decidirServico(tx, conta, acao)))).some(d => d.permite);
    const oficiais = conta.perfil === 'COMUM' && !geral ? await orgaosOficiaisDaConta(tx, conta, dia, this.atuacao) : [];
    return { conta, dia, poder, geral, oficiais, orgaos: poder ? [] : await orgaosDeAtuacao(tx, conta, dia) };
  }

  private async conferirFicha(tx: Prisma.TransactionClient, req, orgao: { id: string; tipo: string; tipo_padrao: string | null; gestao_presidencial: boolean }) {
    if (!sociedadeJuvenil(orgao.tipo_padrao) && req.user.perfil !== 'COMUM') return true;
    const acesso = await this.acessoInstitucional(tx, req);
    if (!sociedadeJuvenil(orgao.tipo_padrao) && (acesso.geral || acesso.oficiais.includes(orgao.id))) return true;
    const contextual = orgao.tipo === 'SOCIEDADE_INTERNA' || orgao.gestao_presidencial;
    const pode = contextual && (!!acesso.poder || acesso.orgaos.includes(orgao.id));
    if (!pode && req.user.perfil === 'COMUM') throw new NotFoundException('Órgão indisponível para esta conta.');
    return pode;
  }

  @Get('relogio')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  async relogio(@Request() req) {
    const config = await this.prisma.configuracao_fuso_igreja.findUnique({ where: { igreja_id: req.user.igreja_id }, select: { fuso_iana: true } });
    const instante = new Date();
    let dataNoFuso: string | null = null;
    if (config) {
      try { dataNoFuso = dataCivilNoFuso(instante, config.fuso_iana); } catch { /* configuração inválida deve ser revista */ }
    }
    const dataUtc = dataCivilNoFuso(instante, 'UTC');
    return { data_utc: dataUtc, data_operacional: config ? dataNoFuso : dataUtc, fuso_iana: config?.fuso_iana ?? null, data_no_fuso: dataNoFuso };
  }

  @Get()
  @ServicoEmContexto('ORGAOS_CONSULTAR')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  async listar(@Request() req, @Query('cursor') cursor?: string, @Query('data') dia?: string) {
    const igrejaId = req.user.igreja_id;
    if (dia && !z.iso.date().safeParse(dia).success) throw new BadRequestException('Data inválida.');
    return this.prisma.$transaction(async tx => {
      const acesso = await this.acessoInstitucional(tx, req);
      const scope: Prisma.orgao_internoWhereInput = { igreja_id: igrejaId, ...(req.user.perfil === 'COMUM' && !acesso.geral && {
        OR: [{ id: { in: [...acesso.orgaos, ...acesso.oficiais] } },
          ...(acesso.poder ? [{ tipo: 'SOCIEDADE_INTERNA' as const }, { gestao_presidencial: true }] : [])],
      }) };
      if (cursor && (!z.uuid().safeParse(cursor).success || !await tx.orgao_interno.findFirst({ where: { AND: [scope, { id: cursor }] }, select: { id: true } })))
        throw new BadRequestException('Cursor inválido.');
      const registros = await tx.orgao_interno.findMany({ where: scope, select: { id: true, tipo: true, categoria: true, tipo_padrao: true, origem: true, constituicao: true,
        nome: true, sigla: true, ativo: true, data_criacao: true, criado_em: true, gestao_presidencial: true }, orderBy: { id: 'asc' }, take: 51,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const pagina = registros.slice(0, 50);
      const itens = await Promise.all(pagina.map(async orgao => {
        if (!dia || !['CONSELHO','JUNTA','UNIDADE_MINISTERIAL','SOCIEDADE_INTERNA'].includes(orgao.tipo)) return orgao;
        const data = new Date(dia), where = { orgao_id: orgao.id, igreja_id: igrejaId };
        if (!await this.vigenteNaData(tx, igrejaId, orgao, data)) return orgao;
        const periodo = { inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] };
        const integrantes = orgao.tipo === 'CONSELHO' || orgao.tipo === 'JUNTA'
          ? (await this.composicao.consultarNaTransacao(tx, igrejaId, orgao.tipo, dia, undefined, orgao.id)).membros.length
          : (await tx.membro_orgao.findMany({ where: { ...where, ...periodo }, distinct: ['pessoa_id'], select: { pessoa_id: true } })).length;
        const vagas = await tx.cargo_orgao.count({ where: { ...where, ativo: true, ocupacoes: { none: { ...periodo, AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }] } } } });
        return { ...orgao, integrantes, vagas };
      }));
      const resumo = await this.resumirOrgaos(tx, scope, igrejaId, dia);
      return { itens, resumo, pode_gerir_sociedades: !!acesso.poder && recursoDaIgreja('orgaos_gestao', igrejaId), proximo_cursor: registros.length > 50 ? pagina[pagina.length - 1].id : null };
    }, { isolationLevel: 'RepeatableRead' });
  }

  private async resumirOrgaos(tx: Prisma.TransactionClient, scope: Prisma.orgao_internoWhereInput, igrejaId: string, dia?: string) {
    const orgaos = await tx.orgao_interno.findMany({
      where: { AND: [scope, { OR: [{ ativo: true }, { tipo: { in: ['CONSELHO', 'JUNTA'] } }] }] },
      select: { id: true, tipo: true, ativo: true },
    });
    const ativos = orgaos.filter(orgao => orgao.ativo);
    const conselhos = orgaos.filter(orgao => orgao.tipo === 'CONSELHO').map(orgao => orgao.id);
    const juntas = orgaos.filter(orgao => orgao.tipo === 'JUNTA').map(orgao => orgao.id);
    const data = dia ? new Date(dia) : null;
    const vinculos: Prisma.mandato_oficialWhereInput[] = [];
    // Mandatos legados sem órgão seguem a mesma associação por ofício da ficha do Conselho ou da Junta.
    if (conselhos.length) vinculos.push({ oficial: { tipo: 'PRESBITERO_REGENTE' }, OR: [{ orgao_id: { in: conselhos } }, { orgao_id: null }] });
    if (juntas.length) vinculos.push({ oficial: { tipo: 'DIACONO' }, OR: [{ orgao_id: { in: juntas } }, { orgao_id: null }] });
    const mandatos = data && vinculos.length ? await tx.mandato_oficial.count({
      where: { igreja_id: igrejaId, data_posse: { lte: data }, OR: [
        { termino_efetivo: { gte: data } }, { termino_efetivo: null, termino_previsto: { gte: data } },
      ], AND: [{ OR: vinculos }] },
    }) : 0;
    return {
      oficiais: ativos.filter(orgao => orgao.tipo === 'ASSEMBLEIA_GERAL' || orgao.tipo === 'CONSELHO' || orgao.tipo === 'JUNTA').length,
      sociedades: ativos.filter(orgao => orgao.tipo === 'SOCIEDADE_INTERNA').length,
      unidades: ativos.filter(orgao => orgao.tipo === 'UNIDADE_MINISTERIAL').length,
      mandatos_vigentes: data ? mandatos : null,
    };
  }

  @Post(':id/mandatos/previa')
  @ServicoDaRota('MANDATOS_REGISTRAR')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  previaMandato(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.mandatos.executar(req.user, id, dados, false);
  }

  @Get(':id/mandatos/indicacoes')
  @ServicoDaRota('MANDATOS_REGISTRAR')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  @Header('Cache-Control', 'private, no-store')
  indicacoesMandato(@Request() req, @Param('id', ParseUUIDPipe) id: string,
    @Query('pessoa', ParseUUIDPipe) pessoa: string, @Query('ata', ParseUUIDPipe) ata: string) {
    return this.mandatos.indicacoes(req.user, id, pessoa, ata);
  }

  @Post(':id/mandatos')
  @ServicoDaRota('MANDATOS_REGISTRAR')
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO)
  registrarMandato(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dados: unknown) {
    return this.mandatos.executar(req.user, id, dados, true);
  }

  @Get(':id/mandatos')
  @ServicoEmContexto('ORGAOS_CONSULTAR')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  periodos(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Query('cursor') cursor?: string) {
    const igreja_id = req.user.igreja_id;
    return this.prisma.$transaction(async tx => {
      const orgao = await tx.orgao_interno.findFirst({ where: { id, igreja_id, tipo: { in: ['JUNTA','CONSELHO'] } } });
      if (!orgao) throw new NotFoundException('Órgão indisponível.');
      await this.conferirFicha(tx, req, orgao);
      const oficio = orgao.tipo === 'JUNTA' ? 'DIACONO' as const : 'PRESBITERO_REGENTE' as const;
      const where = { igreja_id, oficial: { tipo: oficio }, OR: [{ orgao_id: id }, { orgao_id: null }] };
      if (cursor && (!z.uuid().safeParse(cursor).success || !await tx.mandato_oficial.findFirst({ where: { ...where, id: cursor }, select: { id: true } }))) throw new BadRequestException('Cursor de mandato inválido.');
      const sensivel = await tx.acesso_eventos_sensiveis.findFirst({ where: { igreja_id, usuario_id: req.user.sub, revogado_em: null, pode_consultar: true }, select: { id: true } });
      const periodos = await tx.mandato_oficial.findMany({ where, select: { id: true, orgao_id: true, data_eleicao: true, data_posse: true,
        termino_previsto: true, termino_efetivo: true, motivo_encerramento: !!sensivel, versao_orgao: { select: { numero: true } },
        oficial: { select: { id: true, tipo: true, ativo: true, pessoa: { select: { id: true, nome_completo: true } } } } },
        orderBy: [{ data_posse: 'desc' }, { id: 'asc' }], take: 31, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const estado = await estadoDaLiberacao(tx, igreja_id, 'MANDATOS_REGISTRAR');
      const poder = await permissaoMandato(tx, req.user);
      const registros = await tx.evento_autorizacao.findMany({ where: { igreja_id, acao: 'MANDATO_REGISTRADO', recurso_id: { in: periodos.map(m => m.id) } },
        select: { recurso_id: true, instante: true, operador_id: true } });
      const autores = await tx.usuarios.findMany({ where: { igreja_id, id: { in: registros.map(r => r.operador_id) } }, select: { id: true, nome_usuario: true } });
      const nomes = new Map(autores.map(a => [a.id, a.nome_usuario]));
      const porMandato = new Map(registros.map(r => [r.recurso_id, { operador: nomes.get(r.operador_id), instante: r.instante }]));
      const itens = periodos.slice(0, 30).map(m => {
        const exigeAtribuicao = !!m.orgao_id || estado === 'ATRIBUICAO' || req.user.perfil === 'COMUM';
        const autorizado = exigeAtribuicao ? !!poder && poder.pessoa !== m.oficial.pessoa.id
          : ['GESTOR','ADMINISTRADOR','SECRETARIO'].includes(req.user.perfil);
        return { ...m, registro: porMandato.get(m.id) ?? null,
          pode_encerrar: estado !== 'PAUSADO' && !m.termino_efetivo && autorizado };
      });
      return { itens, proximo_cursor: periodos.length > 30 ? itens[29].id : null,
        pode_registrar: !!poder && orgao.ativo && orgao.tipo_padrao === orgao.tipo };
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Get(':id/docentes')
  @ServicoEmContexto('ORGAOS_CONSULTAR')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  async docentes(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Query('cursor') cursor?: string) {
    const igreja_id = req.user.igreja_id;
    const orgao = await this.prisma.orgao_interno.findFirst({ where: { igreja_id, id, tipo: 'CONSELHO' }, select: { id: true } });
    if (orgao && req.user.perfil === 'COMUM') await this.prisma.$transaction(tx => this.conferirFicha(tx, req, { ...orgao, tipo: 'CONSELHO', tipo_padrao: null, gestao_presidencial: false }));
    if (!orgao) throw new NotFoundException('Conselho indisponível.');
    const where = { igreja_id, tipo: 'PRESBITERO_DOCENTE' as const };
    if (cursor && (!z.uuid().safeParse(cursor).success || !await this.prisma.oficial.findFirst({ where: { ...where, id: cursor }, select: { id: true } }))) throw new BadRequestException('Cursor inválido.');
    const rows = await this.prisma.oficial.findMany({ where, orderBy: { id: 'asc' }, take: 31, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, tipo: true, ativo: true, pessoa: { select: { id: true, nome_completo: true } },
        vinculos_pastorais: { where: { exercicio_institucional: true }, select: { id: true, modalidade: true, data_inicio: true, data_fim: true }, orderBy: { data_inicio: 'desc' } } } });
    return { itens: rows.slice(0,30), proximo_cursor: rows.length > 30 ? rows[29].id : null };
  }

  @Get(':id/atos')
  @ServicoEmContexto('ORGAOS_CONSULTAR')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  async listarAtos(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Query('cursor') cursor?: string) {
    const igrejaId = req.user.igreja_id;
    return this.prisma.$transaction(async tx => {
      const orgao = await tx.orgao_interno.findFirst({ where: { id, igreja_id: igrejaId } });
      if (!orgao) throw new NotFoundException('Órgão não encontrado nesta igreja.');
      if (!await this.conferirFicha(tx, req, orgao)) return { itens: [], proximo_cursor: null };
      if (cursor && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor) || !await tx.ato_orgao.findFirst({ where: { id: cursor, igreja_id: igrejaId, orgao_id: id }, select: { id: true } }))) throw new BadRequestException('Cursor inválido.');
      const registros = await tx.ato_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: id }, select: { id: true, tipo: true, data_efeito: true, criado_em: true, retrato: true, operador: { select: { nome_usuario: true } } }, orderBy: [{ criado_em: 'desc' }, { id: 'desc' }], take: 31, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const itens = registros.slice(0, 30).map(a => {
        const r = a.retrato as { operador?: { nome?: string } } | null;
        return { ...a, operador: { nome_usuario: r?.operador?.nome ?? a.operador.nome_usuario } };
      });
      return { itens, proximo_cursor: registros.length > 30 ? itens[itens.length - 1].id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  @Get(':id/atos/:ato')
  @ServicoEmContexto('ORGAOS_CONSULTAR')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  async detalheAto(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('ato', ParseUUIDPipe) ato: string) {
    return this.prisma.$transaction(async tx => {
      const orgao = await tx.orgao_interno.findFirst({ where: { id, igreja_id: req.user.igreja_id } });
      if (!orgao || !await this.conferirFicha(tx, req, orgao)) throw new NotFoundException('Ato indisponível nesta igreja.');
      const registro = await tx.ato_orgao.findFirst({ where: { id: ato, orgao_id: id, igreja_id: req.user.igreja_id }, select: { id: true, tipo: true, data_efeito: true, autoridade: true, evidencia: true, detalhes: true, retrato: true, criado_em: true } });
      if (!registro) throw new NotFoundException('Ato não encontrado neste órgão e igreja.');
      await tx.logs_atividades.create({ data: { igreja_id: req.user.igreja_id, usuario_id: req.user.sub, acao: 'CONSULTA', tabela_afetada: 'ato_orgao', registro_id: ato } });
      return registro;
    });
  }

  @Get(':id')
  @ServicoEmContexto('ORGAOS_CONSULTAR')
  @ContaComum()
  @Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR, Perfil.COMUM)
  @Header('Cache-Control', 'private, no-store')
  async detalhe(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Query('data') dia: string, @Query('cursor_ocupacao') cursorOcupacao?: string, @Query('cursor_participacao') cursorParticipacao?: string, @Query('inativos') inativos?: string, @Query('cursor_inativo') cursorInativo?: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia ?? '')) throw new BadRequestException('Data inválida.');
    const data = new Date(`${dia}T00:00:00.000Z`);
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== dia) throw new BadRequestException('Data inválida.');
    const igrejaId = req.user.igreja_id;
    return this.prisma.$transaction(async tx => {
      const orgao = await tx.orgao_interno.findFirst({ where: { id, igreja_id: igrejaId }, select: { id: true, nome: true, sigla: true, finalidade: true, tipo: true, categoria: true, tipo_padrao: true, origem: true, gestao_presidencial: true, constituicao: true, criado_em: true, data_criacao: true, ativo: true } });
      if (!orgao) throw new NotFoundException('Órgão não encontrado nesta igreja.');
      const nominal = await this.conferirFicha(tx, req, orgao);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (cursorOcupacao && (!nominal || !uuid.test(cursorOcupacao) || !await tx.ocupacao_cargo.findFirst({ where: { id: cursorOcupacao, igreja_id: igrejaId, orgao_id: id }, select: { id: true } }))) throw new BadRequestException('Cursor de ocupação inválido.');
      if (cursorParticipacao && (!nominal || !uuid.test(cursorParticipacao) || !await tx.membro_orgao.findFirst({ where: { id: cursorParticipacao, igreja_id: igrejaId, orgao_id: id }, select: { id: true } }))) throw new BadRequestException('Cursor de participação inválido.');
      const [cargos, membros, cargosConfigurados, atosDesignacao, politicas] = await Promise.all([
        nominal ? tx.ocupacao_cargo.findMany({ where: { igreja_id: igrejaId, orgao_id: id }, select: { id: true, cargo_id: true, inicio: true, inicio_ordem: true, fim: true, fim_ordem: true, termino_previsto: true, retrato: true, pessoa: { select: { id: true, nome_completo: true } }, cargo: { select: { nome: true } } }, orderBy: [{ inicio: 'desc' }, { inicio_ordem: 'desc' }, { id: 'asc' }], take: 101, ...(cursorOcupacao ? { cursor: { id: cursorOcupacao }, skip: 1 } : {}) }) : [],
        nominal ? tx.membro_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: id }, select: { id: true, inicio: true, inicio_ordem: true, fim: true, fim_ordem: true, retrato: true, categoria_participacao: true, pessoa: { select: { id: true, nome_completo: true, data_nascimento: true, sexo: true } } }, orderBy: [{ inicio: 'desc' }, { id: 'asc' }], take: 101, ...(cursorParticipacao ? { cursor: { id: cursorParticipacao }, skip: 1 } : {}) }) : [],
        tx.cargo_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: id, ativo: true }, select: { id: true, nome: true, codigo: true, permite_acumulacao: true }, orderBy: [{ nome: 'asc' }, { id: 'asc' }], take: 101 }),
        tx.ato_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: id, tipo: { in: tiposOrdenados }, data_efeito: data }, select: { detalhes: true } }),
        tx.politica_unidade.findMany({ where: { igreja_id: igrejaId, orgao_id: id }, select: { id: true, versao: true, fonte: true, inicio: true, fim: true, prazo_maximo_meses: true }, orderBy: [{ inicio: 'desc' }, { id: 'asc' }], take: 101 }),
      ]);
      const vigenteNaData = await this.vigenteNaData(tx, igrejaId, orgao, data);
      let composicao: { membros: { pessoa_id: string; nome: string; oficios: string[]; revisao_pendente: boolean }[]; indeterminados: { pessoa_id: string; nome: string }[] } | null = null;
      if (vigenteNaData && (orgao.tipo === 'CONSELHO' || orgao.tipo === 'JUNTA')) {
        const apurada = await this.composicao.consultarNaTransacao(tx, igrejaId, orgao.tipo, dia, undefined, orgao.id);
        const ids = [...new Set([...apurada.membros.map(m => m.pessoa_id), ...apurada.situacao_indeterminada])];
        const pessoas = await tx.pessoas.findMany({ where: { igreja_id: igrejaId, id: { in: ids } }, select: { id: true, nome_completo: true } });
        const nomes = new Map(pessoas.map(p => [p.id, p.nome_completo]));
        composicao = { membros: apurada.membros.map(m => ({ ...m, nome: nomes.get(m.pessoa_id) ?? 'Pessoa indisponível' })), indeterminados: apurada.situacao_indeterminada.map(pessoa_id => ({ pessoa_id, nome: nomes.get(pessoa_id) ?? 'Pessoa indisponível' })) };
      }
      const ordens = atosDesignacao.map(a => a.detalhes && typeof a.detalhes === 'object' && !Array.isArray(a.detalhes) ? a.detalhes.ordem_efeito : null);
      const ordemIndeterminada = ordens.some(o => typeof o !== 'number' || !Number.isSafeInteger(o) || o < 1 || o > 9999) || new Set(ordens).size !== ordens.length;
      const ultimaOrdem = ordemIndeterminada ? null : ordens.reduce<number>((max, o) => Math.max(max, o as number), 0);
      // A situação abaixo é informativa ao fim da data civil, não é apuração de exercício ou competência.
      const ocupacoes = cargos.slice(0, 100), participacoes = membros.slice(0, 100);
      const ativa = (r: { inicio: Date; fim: Date | null }) => vigenteNaData && r.inicio <= data && (!r.fim || r.fim > data);
      const ids = orgao.tipo === 'UNIDADE_MINISTERIAL' ? [...new Set([
        ...ocupacoes.filter(o => ativa(o) && (!o.termino_previsto || o.termino_previsto >= data)).map(o => o.pessoa.id),
        ...participacoes.filter(ativa).map(m => m.pessoa.id),
      ])] : orgao.tipo === 'SOCIEDADE_INTERNA'
        ? [...new Set(participacoes.filter(m => ativa(m) && m.categoria_participacao === 'LOCAL').map(m => m.pessoa.id))]
        : [];
      const eventos = ids.length ? await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: { in: ids }, data_evento: { lte: data } }, select: { pessoa_id: true, data_evento: true, ordem_dia: true, rol: true } }) : [];
      const situacao = (pessoaId: string, lideranca: boolean) => {
        const rol = eventoVigente(eventos.filter(e => e.pessoa_id === pessoaId), data);
        if (rol.situacao !== 'DEFINIDO') return 'INDETERMINADA' as const;
        return (rol.evento.rol === 'COMUNGANTES' || (!lideranca && rol.evento.rol === 'NAO_COMUNGANTES')) ? 'ELEGIVEL' as const : 'NAO_ELEGIVEL' as const;
      };
      let foraDaComposicao: { id: string; nome_completo: string }[] = [];
      if (inativos === '1' && composicao && (orgao.tipo === 'CONSELHO' || orgao.tipo === 'JUNTA')) {
        const oficiais = orgao.tipo === 'JUNTA' ? ['DIACONO' as const] : ['PRESBITERO_REGENTE' as const, 'PRESBITERO_DOCENTE' as const];
        const where = { igreja_id: igrejaId, id: { notIn: [...composicao.membros.map(m => m.pessoa_id), ...composicao.indeterminados.map(m => m.pessoa_id)] },
          oficiais: { some: { tipo: { in: oficiais }, OR: [{ mandatos: { some: { data_posse: { lte: data }, OR: [{ orgao_id: id }, { orgao_id: null }] } } },
            { vinculos_pastorais: { some: { exercicio_institucional: true, data_inicio: { lte: data } } } }] } } };
        if (cursorInativo && (!z.uuid().safeParse(cursorInativo).success || !await tx.pessoas.findFirst({ where: { AND: [where, { id: cursorInativo }] }, select: { id: true } }))) throw new BadRequestException('Cursor de integrantes inválido.');
        foraDaComposicao = await tx.pessoas.findMany({ where, select: { id: true, nome_completo: true }, orderBy: { id: 'asc' }, take: 31,
          ...(cursorInativo ? { cursor: { id: cursorInativo }, skip: 1 } : {}) });
      }
      const contaRegistro = orgao.ativo && contextoComCargos(orgao.tipo) &&
        recursoDaIgreja('orgaos_gestao', igrejaId) && recursoDaIgreja('secretaria', igrejaId) &&
        req.user.perfil !== 'AUDITOR' ? await contaDaSessao(tx, req.user) : null;
      const podeRegistrarCargos = !!contaRegistro?.pessoa_id && (await decidirServico(tx, contaRegistro, 'CARGOS_REGISTRAR')).permite;
      const preparoRegistro = contaRegistro?.perfil === 'ADMINISTRADOR' && !contaRegistro.pessoa_id ? 'VINCULAR_PESSOA' : null;
      const cargosNaData = vigenteNaData && nominal ? await tx.cargo_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: id, ativo: true }, select: {
        id: true, nome: true, ocupacoes: { where: { inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }],
          AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }] }, select: { id: true, inicio: true, fim: true, termino_previsto: true, pessoa: { select: { id: true, nome_completo: true } } } }
      }, orderBy: [{ nome: 'asc' }, { id: 'asc' }], take: 100 }) : [];
      const idsOcupacoes = cargosNaData.flatMap(c => c.ocupacoes.map(o => o.id));
      const registrosCargos = idsOcupacoes.length ? await tx.$queryRaw<{ id: string; ocupacao: string }[]>`
        SELECT id, detalhes->>'ocupacao_id' AS ocupacao FROM ato_orgao
        WHERE igreja_id = ${igrejaId} AND orgao_id = ${id} AND tipo IN ('ELEICAO_CARGO', 'ELEICAO_CARGO_UNIDADE')
          AND detalhes->>'ocupacao_id' IN (${Prisma.join(idsOcupacoes)})` : [];
      const atosDePosse = new Map(registrosCargos.map(r => [r.ocupacao, r.id]));
      const contexto = nominal && recursoDaIgreja('secretaria', igrejaId) ? await tx.contexto_secretaria.findUnique({ where: { orgao_id: id }, select: { id: true } }) : null;
      const versao = await tx.versao_orgao.findFirst({ where: { orgao_id: id, igreja_id: igrejaId, inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] }, select: { numero: true, fonte: true, configuracao: true } });
      const podeConfigurar = nominal && recursoDaIgreja('orgaos_gestao', igrejaId) &&
        (req.user.perfil === Perfil.ADMINISTRADOR ||
          !!await presidenciaSociedades(tx, await contaDaSessao(tx, req.user), await hojeDaIgreja(tx, igrejaId)));
      const prazoSugerido = configuracaoOrgao(versao?.configuracao).cargo_prazo_sugerido_meses;
      const regra = regrasSociedade.safeParse(configuracaoOrgao(versao?.configuracao).regra_sociedade);
      function revisaoEtaria(m: typeof participacoes[number]) {
        if (!regra.success || !ativa(m) || regra.data.idade_maxima === null) return null;
        const saida = faixaCivil(m.pessoa.data_nascimento, regra.data.idade_maxima + 1);
        if (saida > dia && new Date(saida).getTime() - data.getTime() > 90 * 86_400_000) return null;
        return { data_limite: saida, situacao: saida <= dia ? 'REVISAR' : 'PROXIMA', destino: orgao!.tipo_padrao === 'UPA' ? 'UMP' : orgao!.tipo_padrao === 'UCP' ? 'UPA' : null };
      }
      function direitoVoto(m: typeof participacoes[number]) {
        if (!regra.success || !ativa(m) || !cabeNaFaixa(regra.data, m.pessoa.data_nascimento, dia) ||
          (regra.data.sexo && regra.data.sexo !== m.pessoa.sexo)) return false;
        if (m.categoria_participacao === 'LOCAL') return situacao(m.pessoa.id, false) === 'ELEGIVEL';
        if (m.categoria_participacao === 'ESCOLA_DOMINICAL') return regra.data.escola_dominical;
        return m.categoria_participacao === 'AUTORIZACAO_CONSELHO' && orgao!.tipo_padrao === 'SAF';
      }
      return { orgao, consulta_nominal: nominal, pode_configurar: podeConfigurar,
        prazo_sugerido_cargos: typeof prazoSugerido === 'number' ? prazoSugerido : null,
        fora_da_composicao: foraDaComposicao.slice(0,30), proximo_cursor_inativo: foraDaComposicao.length > 30 ? foraDaComposicao[29].id : null,
        cargos_na_data: cargosNaData.map(c => ({ id: c.id, nome: c.nome, titulares: c.ocupacoes.map(o => o.pessoa), ocupacoes: c.ocupacoes.map(o => ({ ...o, ato_id: atosDePosse.get(o.id) ?? null })) })), pode_registrar_cargos: podeRegistrarCargos, preparo_registro_cargos: preparoRegistro, contexto_id: contexto?.id ?? null, versao: versao && { numero: versao.numero, fonte: versao.fonte }, data_referencia: dia, vigente_na_data: vigenteNaData, composicao, cargos_configurados: cargosConfigurados.slice(0, 100), cargos_limitados: cargosConfigurados.length > 100, politicas: politicas.slice(0, 100), politicas_limitadas: politicas.length > 100, ultima_ordem_designacao: ultimaOrdem, ordem_designacao_indeterminada: ordemIndeterminada, ocupacoes: ocupacoes.map(o => ({ ...o, pessoa: { ...o.pessoa, nome_completo: (o.retrato as { pessoa?: { nome?: string } } | null)?.pessoa?.nome ?? o.pessoa.nome_completo }, cargo: { nome: (o.retrato as { cargo?: { nome?: string } } | null)?.cargo?.nome ?? o.cargo.nome }, situacao_membresia: orgao.tipo === 'UNIDADE_MINISTERIAL' && ativa(o) && (!o.termino_previsto || o.termino_previsto >= data) ? situacao(o.pessoa.id, true) : null })), ocupacoes_limitadas: cargos.length > 100, proximo_cursor_ocupacao: cargos.length > 100 ? ocupacoes[ocupacoes.length - 1].id : null, participacoes: participacoes.map(({ pessoa, ...m }) => ({ ...m, pessoa: { id: pessoa.id, nome_completo: (m.retrato as { pessoa?: { nome?: string } } | null)?.pessoa?.nome ?? pessoa.nome_completo },
          revisao_faixa: revisaoEtaria({ ...m, pessoa }),
          direito_voto: direitoVoto({ ...m, pessoa }),
          situacao_membresia: orgao.tipo === 'UNIDADE_MINISTERIAL' && ativa(m) ? situacao(pessoa.id, false) : null })), participacoes_limitadas: membros.length > 100, proximo_cursor_participacao: membros.length > 100 ? participacoes[participacoes.length - 1].id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
