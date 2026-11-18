import { tiposOrdenados } from './ordem-ato';
import { BadRequestException, Controller, Get, Header, NotFoundException, Param, ParseUUIDPipe, Query, Request, UseGuards } from '@nestjs/common';
import { Prisma, usuarios_perfil as Perfil } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { ComposicaoService } from './composicao.service';
import { OrgaosGuard } from './orgaos.guard';
import { dataCivilNoFuso } from './relogio-igreja';

@Controller('orgaos')
@UseGuards(AuthGuard, RolesGuard, OrgaosGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.GESTOR, Perfil.SECRETARIO, Perfil.AUDITOR)
export class OrgaosController {
  constructor(private readonly prisma: PrismaService, private readonly composicao: ComposicaoService) {}

  @Get('relogio')
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
  @Header('Cache-Control', 'private, no-store')
  async listar(@Request() req, @Query('cursor') cursor?: string) {
    const igrejaId = req.user.igreja_id;
    if (cursor && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor) || !await this.prisma.orgao_interno.findFirst({ where: { id: cursor, igreja_id: igrejaId }, select: { id: true } }))) throw new BadRequestException('Cursor inválido.');
    const registros = await this.prisma.orgao_interno.findMany({ where: { igreja_id: igrejaId }, select: { id: true, tipo: true, constituicao: true, nome: true, sigla: true, ativo: true }, orderBy: { id: 'asc' }, take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const itens = registros.slice(0, 50);
    return { itens, proximo_cursor: registros.length > 50 ? itens[itens.length - 1].id : null };
  }

  @Get(':id/atos')
  @Header('Cache-Control', 'private, no-store')
  async listarAtos(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Query('cursor') cursor?: string) {
    const igrejaId = req.user.igreja_id;
    return this.prisma.$transaction(async tx => {
      if (!await tx.orgao_interno.findFirst({ where: { id, igreja_id: igrejaId }, select: { id: true } })) throw new NotFoundException('Órgão não encontrado nesta igreja.');
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
  @Header('Cache-Control', 'private, no-store')
  async detalheAto(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Param('ato', ParseUUIDPipe) ato: string) {
    return this.prisma.$transaction(async tx => {
      const registro = await tx.ato_orgao.findFirst({ where: { id: ato, orgao_id: id, igreja_id: req.user.igreja_id }, select: { id: true, tipo: true, data_efeito: true, autoridade: true, evidencia: true, detalhes: true, retrato: true, criado_em: true } });
      if (!registro) throw new NotFoundException('Ato não encontrado neste órgão e igreja.');
      await tx.logs_atividades.create({ data: { igreja_id: req.user.igreja_id, usuario_id: req.user.sub, acao: 'CONSULTA', tabela_afetada: 'ato_orgao', registro_id: ato } });
      return registro;
    });
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  async detalhe(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Query('data') dia: string, @Query('cursor_ocupacao') cursorOcupacao?: string, @Query('cursor_participacao') cursorParticipacao?: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia ?? '')) throw new BadRequestException('Data inválida.');
    const data = new Date(`${dia}T00:00:00.000Z`);
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== dia) throw new BadRequestException('Data inválida.');
    const igrejaId = req.user.igreja_id;
    return this.prisma.$transaction(async tx => {
      const orgao = await tx.orgao_interno.findFirst({ where: { id, igreja_id: igrejaId }, select: { id: true, nome: true, sigla: true, finalidade: true, tipo: true, constituicao: true, data_criacao: true, ativo: true } });
      if (!orgao) throw new NotFoundException('Órgão não encontrado nesta igreja.');
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (cursorOcupacao && (!uuid.test(cursorOcupacao) || !await tx.ocupacao_cargo.findFirst({ where: { id: cursorOcupacao, igreja_id: igrejaId, orgao_id: id }, select: { id: true } }))) throw new BadRequestException('Cursor de ocupação inválido.');
      if (cursorParticipacao && (!uuid.test(cursorParticipacao) || !await tx.membro_orgao.findFirst({ where: { id: cursorParticipacao, igreja_id: igrejaId, orgao_id: id }, select: { id: true } }))) throw new BadRequestException('Cursor de participação inválido.');
      const [desativacao, cargos, membros, cargosConfigurados, atosDesignacao, politicas] = await Promise.all([
        tx.ato_orgao.findFirst({ where: { igreja_id: igrejaId, orgao_id: id, tipo: 'DESATIVACAO' }, select: { data_efeito: true }, orderBy: { data_efeito: 'desc' } }),
        tx.ocupacao_cargo.findMany({ where: { igreja_id: igrejaId, orgao_id: id }, select: { id: true, inicio: true, inicio_ordem: true, fim: true, fim_ordem: true, termino_previsto: true, retrato: true, pessoa: { select: { id: true, nome_completo: true } }, cargo: { select: { nome: true } } }, orderBy: [{ inicio: 'desc' }, { inicio_ordem: 'desc' }, { id: 'asc' }], take: 101, ...(cursorOcupacao ? { cursor: { id: cursorOcupacao }, skip: 1 } : {}) }),
        tx.membro_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: id }, select: { id: true, inicio: true, inicio_ordem: true, fim: true, fim_ordem: true, retrato: true, pessoa: { select: { id: true, nome_completo: true } } }, orderBy: [{ inicio: 'desc' }, { id: 'asc' }], take: 101, ...(cursorParticipacao ? { cursor: { id: cursorParticipacao }, skip: 1 } : {}) }),
        tx.cargo_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: id, ativo: true }, select: { id: true, nome: true, codigo: true, permite_acumulacao: true }, orderBy: [{ nome: 'asc' }, { id: 'asc' }], take: 101 }),
        tx.ato_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: id, tipo: { in: tiposOrdenados }, data_efeito: data }, select: { detalhes: true } }),
        tx.politica_unidade.findMany({ where: { igreja_id: igrejaId, orgao_id: id }, select: { id: true, versao: true, fonte: true, inicio: true, fim: true, prazo_maximo_meses: true }, orderBy: [{ inicio: 'desc' }, { id: 'asc' }], take: 101 }),
      ]);
      const vigenteNaData = orgao.data_criacao <= data && (orgao.ativo || !!desativacao) && (!desativacao || desativacao.data_efeito > data);
      let composicao: { membros: { pessoa_id: string; nome: string; oficios: string[]; revisao_pendente: boolean }[]; indeterminados: { pessoa_id: string; nome: string }[] } | null = null;
      if (vigenteNaData && orgao.tipo !== 'UNIDADE_MINISTERIAL') {
        const apurada = await this.composicao.consultarNaTransacao(tx, igrejaId, orgao.tipo, dia);
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
      ])] : [];
      const eventos = ids.length ? await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: { in: ids }, data_evento: { lte: data } }, select: { pessoa_id: true, data_evento: true, ordem_dia: true, rol: true } }) : [];
      const situacao = (pessoaId: string, lideranca: boolean) => {
        const rol = eventoVigente(eventos.filter(e => e.pessoa_id === pessoaId), data);
        if (rol.situacao !== 'DEFINIDO') return 'INDETERMINADA' as const;
        return (rol.evento.rol === 'COMUNGANTES' || (!lideranca && rol.evento.rol === 'NAO_COMUNGANTES')) ? 'ELEGIVEL' as const : 'NAO_ELEGIVEL' as const;
      };
      return { orgao, data_referencia: dia, vigente_na_data: vigenteNaData, composicao, cargos_configurados: cargosConfigurados.slice(0, 100), cargos_limitados: cargosConfigurados.length > 100, politicas: politicas.slice(0, 100), politicas_limitadas: politicas.length > 100, ultima_ordem_designacao: ultimaOrdem, ordem_designacao_indeterminada: ordemIndeterminada, ocupacoes: ocupacoes.map(o => ({ ...o, pessoa: { ...o.pessoa, nome_completo: (o.retrato as { pessoa?: { nome?: string } } | null)?.pessoa?.nome ?? o.pessoa.nome_completo }, cargo: { nome: (o.retrato as { cargo?: { nome?: string } } | null)?.cargo?.nome ?? o.cargo.nome }, situacao_membresia: orgao.tipo === 'UNIDADE_MINISTERIAL' && ativa(o) && (!o.termino_previsto || o.termino_previsto >= data) ? situacao(o.pessoa.id, true) : null })), ocupacoes_limitadas: cargos.length > 100, proximo_cursor_ocupacao: cargos.length > 100 ? ocupacoes[ocupacoes.length - 1].id : null, participacoes: participacoes.map(m => ({ ...m, pessoa: { ...m.pessoa, nome_completo: (m.retrato as { pessoa?: { nome?: string } } | null)?.pessoa?.nome ?? m.pessoa.nome_completo }, situacao_membresia: orgao.tipo === 'UNIDADE_MINISTERIAL' && ativa(m) ? situacao(m.pessoa.id, false) : null })), participacoes_limitadas: membros.length > 100, proximo_cursor_participacao: membros.length > 100 ? participacoes[participacoes.length - 1].id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
