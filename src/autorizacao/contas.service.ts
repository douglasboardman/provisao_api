import { permissoesAtas } from '../secretaria/sigilo-ata';
import { codigosServico, gruposServico, rotulosServico, Servico } from './catalogo-servicos';
import { RotasServicosService } from './rotas-servicos.service';
import { orgaosDeAtuacao, orgaosOficiaisDaConta, presidenciaSociedades } from '../orgaos/acesso-sociedades';
import { SecretariaBaseService } from '../secretaria/secretaria-base.service';
import { configuracaoSchema } from '../secretaria/secretaria.dto';
import { recursoDaIgreja } from '../feature-flags/feature-flags';
import { AtuacaoModeloService } from '../secretaria/atuacao-modelo.service';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { hashAto, transacaoSerializavel } from '../orgaos/idempotencia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { ComposicaoService } from '../orgaos/composicao.service';
import { Ator, contaDaSessao, camposConta, compativel, Conta, decisaoAtribuicoes, decidirAcaoModelo, decidirServico, fundamento, papeisDaConta, servicos, Tx } from './politica';
import { filtrarAtribuicoesDeModelos } from './validade-modelo';

const escolha = z.strictObject({ pessoa_id: z.uuid(), conta_id: z.uuid().nullable(), anterior_id: z.uuid().nullable(), fundamento: fundamento.optional() });
const concessao = z.strictObject({ acao: servicos, inicio: z.iso.datetime({ offset: true }),
  fim: z.iso.datetime({ offset: true }).nullable(), fundamento: fundamento.optional() });
const justificativa = z.strictObject({ fundamento });
const revogacao = justificativa.partial();
function conflitoConcorrente(erro: unknown): never {
  if (erro instanceof Prisma.PrismaClientKnownRequestError && ['P2002','P2004'].includes(erro.code))
    throw new ConflictException('Outra decisão foi registrada para este escopo. Atualize os dados.');
  throw erro;
}

function validar<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException('Confira os dados e o fundamento informados.');
  return r.data;
}

@Injectable()
export class ContasAutorizacaoService {
  constructor(private readonly db: PrismaService, private readonly composicao: ComposicaoService, private readonly atuacao: AtuacaoModeloService, private readonly secretaria: SecretariaBaseService, private readonly rotas: RotasServicosService) {}

  private async administrador(tx: Tx, a: Ator, escrita = true) {
    const u = await contaDaSessao(tx, a);
    if (u.perfil !== 'ADMINISTRADOR' || (escrita && !u.pessoa_id))
      throw new ForbiddenException('A governança exige administrador identificado.');
    return u;
  }

  private async destinatario(tx: Tx, igreja_id: string, id: string) {
    const u = await tx.usuarios.findFirst({ where: { id, igreja_id }, select: camposConta });
    if (!u) throw new NotFoundException('Conta não encontrada.');
    return u;
  }

  private independente(operador: Conta, usuario: Conta) {
    if (operador.id === usuario.id || !usuario.pessoa_id || operador.pessoa_id === usuario.pessoa_id)
      throw new ForbiddenException('Outra pessoa identificada deve registrar esta decisão.');
  }

  private evento(tx: Tx, operador: Conta, acao: string, recurso_id: string, motivo: string,
    pessoa_id: string | null, destinatario_id: string | null, dados: Prisma.InputJsonObject) {
    return tx.evento_autorizacao.create({ data: { igreja_id: operador.igreja_id, operador_id: operador.id,
      operador_pessoa_id: operador.pessoa_id, acao, recurso_id, fundamento: motivo, pessoa_id, destinatario_id, dados } });
  }

  escolher(a: Ator, body: unknown) {
    const v = validar(escolha, body);
    return transacaoSerializavel(this.db, async tx => {
      const u = await this.administrador(tx, a);
      if (u.pessoa_id === v.pessoa_id) throw new ForbiddenException('Outra pessoa deve escolher sua conta de atuação.');
      const pessoa = await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id: u.igreja_id }, select: { id: true } });
      if (!pessoa) throw new NotFoundException('Pessoa não encontrada.');
      const anterior = await tx.usuarios.findFirst({ where: { igreja_id: u.igreja_id, pessoa_id: pessoa.id, conta_atuacao: true }, select: { id: true } });
      if ((anterior?.id ?? null) !== v.anterior_id) throw new ConflictException('A escolha foi alterada. Atualize os dados.');
      if (v.conta_id) {
        const alvo = await this.destinatario(tx, u.igreja_id, v.conta_id);
        this.independente(u, alvo);
        if (!alvo.ativo || alvo.pessoa_id !== pessoa.id || ['AUDITOR','ADMINISTRADOR'].includes(alvo.perfil))
          throw new BadRequestException('Selecione uma conta operacional ativa e vinculada à pessoa.');
      }
      if (v.conta_id !== v.anterior_id) {
        if (anterior) await tx.usuarios.update({ where: { id: anterior.id }, data: { conta_atuacao: false } });
        if (v.conta_id) await tx.usuarios.update({ where: { id: v.conta_id }, data: { conta_atuacao: true } });
        const motivo = v.fundamento ?? (v.conta_id === null ? 'Retirada da conta de atuação institucional.'
          : anterior ? 'Troca da conta de atuação institucional.' : 'Seleção da conta de atuação institucional.');
        await this.evento(tx, u, 'ESCOLHER_CONTA', pessoa.id, motivo, pessoa.id, v.conta_id, { anterior_id: v.anterior_id });
      }
      return { conta_id: v.conta_id };
    }).catch(conflitoConcorrente);
  }

  conceder(a: Ator, id: string, body: unknown) {
    const v = validar(concessao, body), inicio = new Date(v.inicio), fim = v.fim ? new Date(v.fim) : null;
    if (fim && (fim <= inicio || fim <= new Date())) throw new BadRequestException('Vigência inválida.');
    return transacaoSerializavel(this.db, async tx => {
      const u = await this.administrador(tx, a);
      const alvo = await this.destinatario(tx, u.igreja_id, id);
      if (u.id !== alvo.id || v.acao !== 'CARGOS_REGISTRAR') this.independente(u, alvo);
      if (!alvo.ativo || !compativel(alvo.perfil, v.acao)) throw new BadRequestException('Serviço incompatível com a conta.');
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id=${id} FOR UPDATE`;
      const where = { usuario_id: id, igreja_id: u.igreja_id, geracao_vinculo: alvo.geracao_vinculo, acao: v.acao, revogado_em: null };
      if (await tx.atribuicao_servico.findFirst({ where: { ...where, ...(fim && { inicio: { lt: fim } }),
        OR: [{ fim: null }, { fim: { gt: inicio } }] } })) throw new ConflictException('Já existe atribuição para o período.');
      const r = await tx.atribuicao_servico.create({ data: { ...where, pessoa_id: alvo.pessoa_id!, inicio, fim } });
      await this.evento(tx, u, 'CONCEDER_SERVICO', r.id, v.fundamento ?? 'Concessão de atribuição de serviço.',
        alvo.pessoa_id, id, { acao: v.acao, inicio: v.inicio, fim: v.fim, escopo: u.igreja_id });
      return { id: r.id };
    }).catch(conflitoConcorrente);
  }

  revogar(a: Ator, id: string, body: unknown) {
    const v = validar(revogacao, body);
    return transacaoSerializavel(this.db, async tx => {
      const u = await this.administrador(tx, a);
      const r = await tx.atribuicao_servico.findFirst({ where: { id, igreja_id: u.igreja_id } });
      if (!r) throw new NotFoundException('Atribuição não encontrada.');
      if (r.concessao_modelo_id) throw new BadRequestException('Revogue a concessão na tela de perfis de acesso.');
      if (!r.revogado_em) {
        await tx.atribuicao_servico.update({ where: { id }, data: { revogado_em: new Date() } });
        await this.evento(tx, u, 'REVOGAR_SERVICO', id, v.fundamento ?? 'Revogação de atribuição de serviço.',
          r.pessoa_id, r.usuario_id, { acao: r.acao });
      }
      return { id };
    });
  }

  consultar(a: Ator, id?: string) {
    return this.db.$transaction(async tx => {
      const operador = id ? await this.administrador(tx, a, false) : await contaDaSessao(tx, a);
      const u = id ? await this.destinatario(tx, operador.igreja_id, id) : operador;
      const selecionada = u.pessoa_id ? await tx.usuarios.findFirst({ where: { igreja_id: u.igreja_id, pessoa_id: u.pessoa_id, conta_atuacao: true }, select: { id: true } }) : null;
      const historicas = await tx.atribuicao_servico.findMany({ where: { usuario_id: u.id, igreja_id: u.igreja_id }, orderBy: { inicio: 'desc' } });
      const atribuicoes = historicas.filter(r => r.geracao_vinculo === u.geracao_vinculo && !r.revogado_em);
      const agora = new Date();
      const consideradas = await filtrarAtribuicoesDeModelos(tx, u, historicas, agora);
      const servicosPropostos = servicos.options.map(acao => ({
        acao, rotulo: rotulosServico[acao], ...decisaoAtribuicoes(u, acao, consideradas.filter(r => r.acao === acao), agora),
      }));
      const cargos: { contexto_id: string; contexto: string; cargo: string; origem_id: string }[] = [];
      if (u.ativo && u.conta_atuacao && u.pessoa_id) {
        const dia = await hojeDaIgreja(tx, u.igreja_id), data = new Date(dia);
        const contextos = await tx.contexto_secretaria.findMany({ where: { igreja_id: u.igreja_id, orgao: { ativo: true } }, include: { orgao: true } });
        for (const c of contextos) {
          const exercicio = await this.atuacao.papeis(tx, c, u.pessoa_id, dia);
          const proposta = await papeisDaConta(tx, u, exercicio, dia);
          if (proposta.presidencia_id) cargos.push({ contexto_id: c.id, contexto: c.orgao.nome, cargo: 'Presidente do Conselho', origem_id: proposta.presidencia_id });
          const ids = [...proposta.papeis].filter(p => p !== 'PRESIDENCIA_CONSELHO');
          if (!ids.length) continue;
          const ocupacoes = await tx.ocupacao_cargo.findMany({ where: { igreja_id: u.igreja_id, pessoa_id: u.pessoa_id, cargo_id: { in: ids },
            inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }], AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }] },
            include: { cargo: { select: { nome: true } } } });
          for (const o of ocupacoes) cargos.push({ contexto_id: c.id, contexto: c.orgao.nome, cargo: o.cargo.nome, origem_id: o.id });
        }
      }
      return { cargos_propostos: cargos, usuario_id: u.id, pessoa_id: u.pessoa_id, conta_atuacao: u.conta_atuacao,
        ...(id && {
          selecionada_id: selecionada?.id ?? null,
          pode_salvar_modelo_atuacao: !!operador.pessoa_id && !!u.pessoa_id && u.ativo,
          catalogo: codigosServico.filter(acao => compativel(u.perfil, acao))
            .map(acao => ({ acao, rotulo: rotulosServico[acao] })),
        }), atribuicoes, servicos_propostos: servicosPropostos };
    }, { isolationLevel: 'RepeatableRead' });
  }

  navegacao(a: Ator) {
    return this.db.$transaction(async tx => {
      const u = await contaDaSessao(tx, a);
      const agora = new Date();
      const configuracoes = await tx.liberacao_servico.findMany({ where: { igreja_id: u.igreja_id }, select: { acao: true, estado: true } });
      const modos = new Map(configuracoes.map(c => [c.acao, c.estado]));
      const registros = await tx.atribuicao_servico.findMany({ where: { igreja_id: u.igreja_id, usuario_id: u.id,
        geracao_vinculo: u.geracao_vinculo, revogado_em: null } });
      const vigentes = registros.filter(r => r.inicio <= agora && (!r.fim || r.fim > agora) &&
        servicos.safeParse(r.acao).success && compativel(u.perfil, r.acao as Servico));
      const efetivas = await filtrarAtribuicoesDeModelos(tx, u, vigentes, agora);
      const ativos = new Set(codigosServico.filter(acao => modos.get(acao) !== 'PAUSADO' &&
        decisaoAtribuicoes(u, acao, efetivas.filter(r => r.acao === acao), agora).permite));
      const concessoes = [...new Set(efetivas.flatMap(r => r.concessao_modelo_id ? [r.concessao_modelo_id] : []))];
      const perfis = concessoes.length ? await tx.modelo_atribuicoes.findMany({
        where: { igreja_id: u.igreja_id, concessoes: { some: { id: { in: concessoes } } } },
        select: { nome: true }, orderBy: { nome_normalizado: 'asc' },
      }) : [];
      const permissoes: Record<string, string[]> = {};
      for (const [modulo, acoes] of Object.entries(gruposServico))
        permissoes[modulo] = Object.entries(acoes).filter(([, acao]) => ativos.has(acao)).map(([operacao]) => operacao);
      permissoes['vinculos-documentais'] = [
        ...(ativos.has('VINCULOS_DOCUMENTAIS_CONSULTAR') ? ['view'] : []),
        ...(ativos.has('VINCULOS_DOCUMENTAIS_REGISTRAR') ? ['edit'] : []),
      ];
      const dia = await hojeDaIgreja(tx, u.igreja_id);
      const presidente = await presidenciaSociedades(tx, u, dia);
      permissoes['perfis-atuacao'] = u.pessoa_id && (u.perfil === 'ADMINISTRADOR' || presidente) ? ['view'] : [];
      const competenciaUnidades = u.perfil === 'COMUM' && u.pessoa_id && await tx.competencia_unidades.findFirst({ where: {
        igreja_id: u.igreja_id, usuario_id: u.id, pessoa_id: u.pessoa_id, inicio: { lte: new Date(dia) },
        OR: [{ fim: null }, { fim: { gt: new Date(dia) } }],
      }, select: { id: true } });
      permissoes['unidades'] = competenciaUnidades ? ['view', 'create', 'edit'] : [];
      if (recursoDaIgreja('orgaos', u.igreja_id) && recursoDaIgreja('governanca', u.igreja_id)) {
        const temOrgao = permissoes.orgaos.length || competenciaUnidades || ativos.has('CARGOS_REGISTRAR') || ativos.has('MANDATOS_REGISTRAR') ||
          !!presidente || (await orgaosOficiaisDaConta(tx, u, dia, this.atuacao)).length > 0 || (await orgaosDeAtuacao(tx, u, dia)).length > 0;
        if (temOrgao && !permissoes.orgaos.includes('view')) permissoes.orgaos.push('view');
      } else { permissoes.orgaos = []; permissoes.unidades = []; }
      if (!recursoDaIgreja('governanca', u.igreja_id)) permissoes.oficiais = [];
      permissoes['notificacoes-oficiais'] = permissoes.oficiais.includes('view') ? ['view'] : [];
      permissoes.secretaria = [];
      permissoes['campos-secretaria'] = [];
      if (recursoDaIgreja('secretaria', u.igreja_id)) {
        const contextos = await tx.contexto_secretaria.findMany({ where: { igreja_id: u.igreja_id }, include: { orgao: true } });
        if ((await Promise.all(contextos.map(c => this.secretaria.contextoVisivel(tx, c, u)))).some(Boolean) ||
          u.pessoa_id && (await permissoesAtas(tx, u.igreja_id, u.pessoa_id)).size) permissoes.secretaria = ['view'];
        if (await this.secretaria.podeGerirCadastros(tx, u)) permissoes['campos-secretaria'] = ['view', 'create', 'edit'];
      } else { permissoes['autorizacoes-financeiras'] = []; }
      if (u.perfil === 'ADMINISTRADOR') permissoes.usuarios.push('create', 'edit', 'delete');
      return { permissoes, perfis_atuacao: perfis.map(p => p.nome) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  compararModelo(a: Ator, usuarioId: string, modeloId: string) {
    return this.db.$transaction(async tx => {
      const operador = await this.administrador(tx, a, false);
      const u = await this.destinatario(tx, operador.igreja_id, usuarioId);
      if (!recursoDaIgreja('secretaria', u.igreja_id)) throw new NotFoundException('Secretaria indisponível.');
      const m = await tx.modelo_documento.findFirst({ where: { id: modeloId, igreja_id: u.igreja_id },
        include: { contexto: { include: { orgao: true } }, rascunho: true, versoes: { orderBy: { numero: 'desc' }, take: 1 } } });
      if (!m) throw new NotFoundException('Modelo não encontrado.');
      const dia = await hojeDaIgreja(tx, u.igreja_id);
      const v = m.versoes[0], config = configuracaoSchema.safeParse(v?.configuracao);
      const regra = !m.rascunho && config.success ? config.data.atuacao : undefined;
      const papeis = await this.atuacao.papeis(tx, m.contexto, u.ativo ? u.pessoa_id : null, dia);
      const vigente = await papeisDaConta(tx, u, papeis, dia);
      return (['criar','preparar'] as const).map(acao => ({ acao, proposta: decidirAcaoModelo(acao, regra, vigente) }));
    }, { isolationLevel: 'RepeatableRead' });
  }

  presidencia(a: Ator, id: string, confirmar: boolean, body: unknown) {
    const v = validar(justificativa, body);
    return transacaoSerializavel(this.db, async tx => {
      const u = await this.administrador(tx, a);
      const autoridade = confirmar ? await decidirServico(tx, u, 'PRESIDENCIA_CONFERIR') : null;
      if (autoridade && !autoridade.permite) throw new ForbiddenException('A conferência exige atribuição vigente de revisor.');
      const dia = await hojeDaIgreja(tx, u.igreja_id), data = new Date(dia);
      const p = await tx.presidencia_conselho.findFirst({ where: { id, igreja_id: u.igreja_id, inicio: { lte: data },
        OR: [{ fim: null }, { fim: { gt: data } }] }, include: { oficial: { select: { pessoa_id: true } } } });
      if (!p) throw new NotFoundException('Presidência vigente não encontrada.');
      const pessoa = p.oficial.pessoa_id;
      if (u.pessoa_id === pessoa) throw new ForbiddenException('O beneficiário não pode verificar a própria presidência.');
      const membros = await this.composicao.consultarNaTransacao(tx, u.igreja_id, 'CONSELHO', dia, [pessoa]);
      if (!membros.membros.some(m => m.oficios.includes('PRESBITERO_DOCENTE') && !m.revisao_pendente))
        throw new ConflictException('O exercício pastoral precisa de conferência.');
      const eventos = await tx.evento_autorizacao.findMany({ where: { igreja_id: u.igreja_id, recurso_id: id,
        acao: { in: ['PRESIDENCIA_ENCAMINHADA','PRESIDENCIA_CONFERIDA'] } } });
      const pedido = eventos.find(e => e.acao === 'PRESIDENCIA_ENCAMINHADA');
      if (confirmar && (!pedido || pedido.operador_id === u.id || pedido.operador_pessoa_id === u.pessoa_id || pedido.pessoa_id !== pessoa))
        throw new ForbiddenException('A conferência exige encaminhamento de outra pessoa identificada.');
      const acao = confirmar ? 'PRESIDENCIA_CONFERIDA' : 'PRESIDENCIA_ENCAMINHADA';
      if (eventos.some(e => e.acao === acao)) throw new ConflictException('Esta etapa já foi registrada.');
      const e = await this.evento(tx, u, acao, id, v.fundamento, pessoa, null, { oficial_id: p.oficial_id, encaminhamento_id: pedido?.id ?? null, atribuicao_revisor_id: autoridade?.origem ?? null });
      return { id: e.id };
    }).catch(conflitoConcorrente);
  }

  historico(a: Ator, cursor?: string) {
    return this.db.$transaction(async tx => {
      const u = await this.administrador(tx, a, false);
      if (cursor && !await tx.evento_autorizacao.findFirst({ where: { id: cursor, igreja_id: u.igreja_id } }))
        throw new BadRequestException('Cursor inválido.');
      const linhas = await tx.evento_autorizacao.findMany({ where: { igreja_id: u.igreja_id }, orderBy: [{ instante: 'desc' }, { id: 'desc' }],
        take: 51, ...(cursor && { cursor: { id: cursor }, skip: 1 }) });
      return { itens: linhas.slice(0, 50), proximo_cursor: linhas.length > 50 ? linhas[49].id : null };
    });
  }
}
