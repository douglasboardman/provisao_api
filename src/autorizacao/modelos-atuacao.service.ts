import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { oficio_tipo, Prisma } from '@prisma/client';
import { z } from 'zod';
import { presidenciaSociedades } from '../orgaos/acesso-sociedades';
import { hashAto, transacaoSerializavel } from '../orgaos/idempotencia';
import { PrismaService } from '../prisma/prisma.service';
import { areasServico, codigosServico, rotulosServico } from './catalogo-servicos';
import { Ator, camposConta, compativel, Conta, contaDaSessao, fundamento, servicos, Tx } from './politica';
import { calendarioPerfis, qualificarPerfil } from './validade-modelo';

const cargosElegiveis = { ativo: true, orgao: { ativo: true, tipo: { in: ['CONSELHO', 'JUNTA'] } } } satisfies Prisma.cargo_orgaoWhereInput;
const oficioNome: Record<oficio_tipo, string> = {
  PRESBITERO_DOCENTE: 'Vínculo pastoral em exercício',
  PRESBITERO_REGENTE: 'Mandato de presbítero regente',
  DIACONO: 'Mandato de diácono',
};
const acoesPermitidas = codigosServico.filter(acao => compativel('COMUM', acao));
const requisitoSchema = z.discriminatedUnion('tipo', [
  z.strictObject({ tipo: z.literal('cargo'), id: z.uuid() }),
  z.strictObject({ tipo: z.literal('oficio'), oficio: z.enum(oficio_tipo) }),
]);
const modeloBase = z.strictObject({
  nome: z.string().transform(v => v.normalize('NFC').trim().replace(/\s+/g, ' ')).pipe(z.string().min(1).max(100)),
  acoes: z.array(servicos).min(1).max(acoesPermitidas.length).refine(acoes =>
    new Set(acoes).size === acoes.length && acoes.every(acao => acoesPermitidas.includes(acao))),
  fundamento: fundamento.optional(),
});
const modeloSchema = z.union([
  modeloBase.extend({ requisitos: z.array(requisitoSchema).min(1).refine(requisitos =>
    new Set(requisitos.map(r => r.tipo === 'cargo' ? r.id : r.oficio)).size === requisitos.length) }),
  modeloBase.extend({ requisito: requisitoSchema }).transform(({ requisito, ...base }) => ({ ...base, requisitos: [requisito] })),
]);
const previaSchema = z.strictObject({ usuario_id: z.uuid() });
const confirmarSchema = previaSchema.extend({ previa: z.string().regex(/^[a-f0-9]{64}$/), fundamento: fundamento.optional() });
const revogarSchema = z.strictObject({ fundamento: fundamento.optional() });
const cargoNome = { select: { nome: true, orgao: { select: { nome: true } } } } as const;
const incluirRequisitos = {
  cargo: cargoNome,
  requisitos_adicionais: { orderBy: { ordem: 'asc' }, include: { cargo: cargoNome } },
} satisfies Prisma.modelo_atribuicoesInclude;

function rotuloRequisito({ cargo, oficio }: { cargo: { nome: string; orgao: { nome: string } } | null; oficio: oficio_tipo | null }) {
  return cargo ? `${cargo.nome} · ${cargo.orgao.nome}` : oficioNome[oficio!];
}

function validar<T>(schema: z.ZodType<T>, body: unknown, mensagem = 'Confira os dados informados.'): T {
  const dados = schema.safeParse(body);
  if (!dados.success) throw new BadRequestException(mensagem);
  return dados.data;
}

@Injectable()
export class ModelosAtuacaoService {
  constructor(private readonly db: PrismaService) {}

  private async operador(tx: Tx, ator: Ator, dia: string, somenteAdmin = false) {
    const conta = await contaDaSessao(tx, ator);
    if (conta.pessoa_id && (conta.perfil === 'ADMINISTRADOR' || (!somenteAdmin && await presidenciaSociedades(tx, conta, dia))))
      return conta;
    throw new ForbiddenException(somenteAdmin ? 'A criação de perfis exige administrador identificado.' :
      'A decisão exige um administrador identificado ou a presidência institucional em exercício.');
  }

  private async buscar(tx: Tx, igreja_id: string, id: string) {
    const modelo = await tx.modelo_atribuicoes.findFirst({ where: { id, igreja_id }, include: incluirRequisitos });
    if (!modelo) throw new NotFoundException('Perfil de acesso não encontrado.');
    return modelo;
  }

  private auditar(tx: Tx, operador: Conta, acao: string, recurso_id: string, fundamento: string, dados: Prisma.InputJsonObject,
    destino?: { pessoa_id: string; usuario_id: string }) {
    return tx.evento_autorizacao.create({ data: { igreja_id: operador.igreja_id, operador_id: operador.id,
      operador_pessoa_id: operador.pessoa_id, acao, recurso_id, fundamento, dados,
      pessoa_id: destino?.pessoa_id, destinatario_id: destino?.usuario_id } });
  }

  listar(ator: Ator) {
    return this.db.$transaction(async tx => {
      const { dia } = await calendarioPerfis(tx, ator.igreja_id, new Date());
      const operador = await this.operador(tx, ator, dia);
      const modelos = await tx.modelo_atribuicoes.findMany({ where: { igreja_id: operador.igreja_id },
        include: incluirRequisitos, orderBy: { nome_normalizado: 'asc' } });
      return { pode_criar: operador.perfil === 'ADMINISTRADOR', modelos: modelos.map(m => ({
        id: m.id, nome: m.nome, requisito: rotuloRequisito(m),
        requisitos: [m, ...m.requisitos_adicionais].map(rotuloRequisito),
        acoes: m.acoes.map(acao => ({ acao, rotulo: rotulosServico[acao] })),
      })) };
    });
  }

  opcoes(ator: Ator) {
    return this.db.$transaction(async tx => {
      const operador = await this.operador(tx, ator, '', true);
      const cargos = await tx.cargo_orgao.findMany({ where: { igreja_id: operador.igreja_id, ...cargosElegiveis },
        select: { id: true, ...cargoNome.select }, orderBy: [{ orgao: { nome: 'asc' } }, { nome: 'asc' }] });
      return {
        cargos: cargos.map(c => ({ id: c.id, nome: `${c.nome} · ${c.orgao.nome}` })),
        oficios: Object.entries(oficioNome).map(([oficio, nome]) => ({ oficio, nome })),
        catalogo: acoesPermitidas.map(acao => ({ acao, rotulo: rotulosServico[acao], area: areasServico[acao] })),
      };
    });
  }

  salvar(ator: Ator, body: unknown) {
    const v = validar(modeloSchema, body, 'Confira o nome, as atribuições e as permissões do perfil.');
    return transacaoSerializavel(this.db, async tx => {
      const operador = await this.operador(tx, ator, '', true);
      const igreja_id = operador.igreja_id;
      const requisitos = v.requisitos.map(r => r.tipo === 'cargo'
        ? { cargo_id: r.id, oficio: null } : { cargo_id: null, oficio: r.oficio });
      const cargos = v.requisitos.flatMap(r => r.tipo === 'cargo' ? [r.id] : []);
      if (cargos.length && await tx.cargo_orgao.count({ where: { id: { in: cargos }, igreja_id, ...cargosElegiveis } }) !== cargos.length)
        throw new NotFoundException('Cargo indisponível para esta igreja.');
      const [primeiro, ...adicionais] = requisitos;
      const modelo = await tx.modelo_atribuicoes.create({ data: { igreja_id, nome: v.nome,
        nome_normalizado: v.nome.toLocaleLowerCase('pt-BR'), acoes: [...v.acoes].sort(), ...primeiro,
        ...(adicionais.length && { requisitos_adicionais: { createMany: {
          data: adicionais.map((r, indice) => ({ ...r, ordem: indice + 1 })),
        } } }) },
        select: { id: true, nome: true } });
      await this.auditar(tx, operador, 'SALVAR_MODELO_ATUACAO', modelo.id, v.fundamento ?? 'Criação de perfil de acesso', {
        nome: modelo.nome, acoes: v.acoes, ...primeiro, requisitos,
      });
      return modelo;
    }).catch(erro => {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002')
        throw new ConflictException('Já existe um perfil de acesso com esse nome nesta igreja.');
      throw erro;
    });
  }

  consultarConcessoes(ator: Ator, modelo_id: string) {
    return this.db.$transaction(async tx => {
      const agora = new Date();
      const { dia } = await calendarioPerfis(tx, ator.igreja_id, agora);
      const operador = await this.operador(tx, ator, dia);
      const igreja_id = operador.igreja_id;
      const modelo = await this.buscar(tx, igreja_id, modelo_id);
      const requisitos = [modelo, ...modelo.requisitos_adicionais];
      const cargos = requisitos.flatMap(r => r.cargo_id ? [r.cargo_id] : []);
      const oficios = requisitos.flatMap(r => r.oficio ? [r.oficio] : []);
      const data = new Date(dia + 'T00:00:00Z');
      const candidatos = await tx.usuarios.findMany({ where: {
        igreja_id, ativo: true, conta_atuacao: true, perfil: 'COMUM', pessoa_id: { not: operador.pessoa_id },
        pessoa: { OR: [
          { ocupacoes_orgao: { some: { cargo_id: { in: cargos }, inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] } } },
          { oficiais: { some: { tipo: { in: oficios } } } },
        ] },
      }, select: { id: true, nome_usuario: true, email_login: true, pessoa_id: true }, orderBy: [{ nome_usuario: 'asc' }, { id: 'asc' }] });
      const disponiveis = await Promise.all(candidatos.map(async ({ pessoa_id, ...conta }) =>
        await qualificarPerfil(tx, requisitos, igreja_id, pessoa_id!, dia) ? conta : null));
      const registros = await tx.concessao_modelo_atuacao.findMany({ where: {
        igreja_id, modelo_id, revogado_em: null, pessoa_id: { not: operador.pessoa_id! },
      }, include: { usuario: { select: { ...camposConta, nome_usuario: true, email_login: true } } },
        orderBy: [{ inicio: 'desc' }, { id: 'asc' }] });
      const qualificacoes = await Promise.all(registros.map(async c => ({
        id: c.id, usuario_id: c.usuario_id, nome_usuario: c.usuario.nome_usuario, email_login: c.usuario.email_login,
        inicio: c.inicio, fim: c.fim, vigente: c.usuario.ativo && c.usuario.conta_atuacao && c.usuario.pessoa_id === c.pessoa_id &&
          c.usuario.geracao_vinculo === c.geracao_vinculo && (!c.fim || c.fim > agora) &&
          !!await qualificarPerfil(tx, requisitos, igreja_id, c.pessoa_id, dia, c.qualificacao_id),
      })));
      return { contas: disponiveis.filter(conta => conta !== null), concessoes: qualificacoes };
    }, { isolationLevel: 'RepeatableRead' });
  }

  atribuir(ator: Ator, modelo_id: string, body: unknown, gravar: boolean) {
    const confirmacao = gravar ? validar(confirmarSchema, body) : null;
    const { usuario_id } = confirmacao ?? validar(previaSchema, body);
    return transacaoSerializavel(this.db, async tx => {
      const agora = new Date();
      const { dia, fuso } = await calendarioPerfis(tx, ator.igreja_id, agora);
      const operador = await this.operador(tx, ator, dia);
      const igreja_id = operador.igreja_id;
      if (confirmacao) await tx.$queryRaw`SELECT id FROM usuarios WHERE igreja_id=${igreja_id} AND id=${usuario_id} FOR UPDATE`;
      const modelo = await this.buscar(tx, igreja_id, modelo_id);
      const alvo = await tx.usuarios.findFirst({ where: { id: usuario_id, igreja_id }, select: camposConta });
      if (!alvo) throw new NotFoundException('Conta indisponível.');
      if (alvo.id === operador.id || alvo.pessoa_id === operador.pessoa_id) throw new ForbiddenException('A concessão exige outro operador.');
      if (!alvo.ativo || !alvo.conta_atuacao || !alvo.pessoa_id || alvo.perfil !== 'COMUM')
        throw new BadRequestException('Selecione uma conta comum ativa, vinculada e marcada para atuação.');
      const origem = await qualificarPerfil(tx, [modelo, ...modelo.requisitos_adicionais], igreja_id, alvo.pessoa_id, dia);
      if (!origem) throw new BadRequestException('A pessoa vinculada precisa exercer o mandato ou cargo exigido pelo perfil.');
      const fim = origem.fimCivil ? (await tx.$queryRaw<{ fim: Date }[]>`
        SELECT (${origem.fimCivil}::date::timestamp AT TIME ZONE ${fuso}) AS fim
      `)[0].fim : null;
      const existing = await tx.atribuicao_servico.findMany({ where: { igreja_id, usuario_id, geracao_vinculo: alvo.geracao_vinculo,
        acao: { in: modelo.acoes }, revogado_em: null, ...(fim && { inicio: { lt: fim } }),
        OR: [{ fim: null }, { fim: { gt: agora } }],
      }, select: { acao: true } });
      const itens = modelo.acoes.map(acao => ({ acao, rotulo: rotulosServico[acao], sobreposta: existing.some(r => r.acao === acao) }));
      const previa = hashAto({ modelo_id, alvo, qualificacao_id: origem.id, fim: fim?.toISOString() ?? null, itens });
      if (!confirmacao) return { previa, fim, itens, requisito: rotuloRequisito(origem.requisito) };
      if (confirmacao.previa !== previa) throw new ConflictException('O exercício ou as atribuições mudaram. Gere outra prévia.');
      const acoes = itens.filter(item => !item.sobreposta).map(item => item.acao);
      if (!acoes.length) throw new ConflictException('Não há atribuições disponíveis para conceder.');
      const escopo = { igreja_id, usuario_id, pessoa_id: alvo.pessoa_id, geracao_vinculo: alvo.geracao_vinculo, inicio: agora, fim };
      const concessao = await tx.concessao_modelo_atuacao.create({ data: { ...escopo, modelo_id, qualificacao_id: origem.id } });
      await tx.atribuicao_servico.createMany({ data: acoes.map(acao => ({ ...escopo, acao, concessao_modelo_id: concessao.id })) });
      await this.auditar(tx, operador, 'ATRIBUIR_MODELO_ATUACAO', concessao.id, confirmacao.fundamento ?? 'Concessão de perfil de acesso.', {
        modelo_id, acoes, qualificacao_id: origem.id, fim: fim?.toISOString() ?? null,
      }, escopo);
      return { id: concessao.id, atribuidas: acoes.length };
    }).catch(erro => {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2004'].includes(erro.code))
        throw new ConflictException('As atribuições mudaram. Gere outra prévia.');
      throw erro;
    });
  }

  revogar(ator: Ator, id: string, body: unknown) {
    const v = validar(revogarSchema, body);
    return transacaoSerializavel(this.db, async tx => {
      const agora = new Date();
      const { dia } = await calendarioPerfis(tx, ator.igreja_id, agora);
      const operador = await this.operador(tx, ator, dia);
      const igreja_id = operador.igreja_id;
      const registro = await tx.concessao_modelo_atuacao.findFirst({ where: { igreja_id, id },
        include: { usuario: { select: { pessoa_id: true } } } });
      if (!registro) throw new NotFoundException('Concessão não encontrada.');
      if ([registro.pessoa_id, registro.usuario.pessoa_id].includes(operador.pessoa_id))
        throw new ForbiddenException('A revogação exige outro operador.');
      if (registro.revogado_em) return { id };
      await tx.concessao_modelo_atuacao.update({ where: { id }, data: { revogado_em: agora } });
      await tx.atribuicao_servico.updateMany({ where: { igreja_id, concessao_modelo_id: id, revogado_em: null }, data: { revogado_em: agora } });
      await this.auditar(tx, operador, 'REVOGAR_MODELO_ATUACAO', id, v.fundamento ?? 'Revogação de perfil de acesso.', { modelo_id: registro.modelo_id }, registro);
      return { id };
    });
  }
}
