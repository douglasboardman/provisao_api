import { contaDaSessao } from '../autorizacao/politica';
import { mesaVigente } from './mesa-assembleia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SessionService } from '../auth/session.service';
import { recursoDaIgreja } from '../feature-flags/feature-flags';
import { Prisma } from '@prisma/client';
import { transacaoComRetentativa, transacaoSerializavel } from '../orgaos/idempotencia';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { configuracaoSchema, reuniaoDadosSchema, validar } from './secretaria.dto';
import type { AtorSecretaria, Tx } from './secretaria-base.service';
import { contaDoConvite, normalizarEmail } from './conta-do-convite';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const conta = { select: { id: true, ativo: true, perfil: true, auth_version: true, email_login: true, conta_atuacao: true } } as const;
const composicao = {
  oficial: { select: { pessoa_id: true } },
  secretario: { select: { email: true, usuarios: conta } },
} as const;
export type CredencialAssembleia = { temporaria?: string; normal?: string; escopo?: unknown };
const indisponivel = () =>
  new ForbiddenException(
    'O acesso à redação está encerrado ou indisponível. As assinaturas seguem pelos convites individuais.',
  );

@Injectable()
export class AcessoAssembleiaService {
  constructor(
    readonly db: PrismaService,
    private readonly sessions: SessionService,
    private readonly fila: OutboxService,
  ) {}

  private async presidencia(tx: Tx, a: AtorSecretaria, id: string) {
    const reuniao = await tx.reuniao.findFirst({ where: { id, igreja_id: a.igreja_id,
      contexto: { orgao: { tipo: 'ASSEMBLEIA_GERAL', ativo: true } } } });
    const mesa = reuniao && await mesaVigente(tx, reuniao);
    const u = await tx.usuarios.findFirst({ where: { id: a.sub, igreja_id: a.igreja_id, ativo: true } });
    if (!reuniao || !mesa || !u || ['ADMINISTRADOR','AUDITOR'].includes(u.perfil) || mesa.oficial.pessoa_id !== u.pessoa_id)
      throw new ForbiddenException('A concessão cabe ao presidente efetivo desta sessão.');
    if (u.perfil === 'COMUM') {
      if (!a.sessao_id || a.auth_version === undefined ||
          !(await contaDaSessao(tx, { ...a, auth_version: a.auth_version, sessao_id: a.sessao_id })).conta_atuacao) throw indisponivel();
    }
    if (u.perfil !== 'COMUM' && await tx.usuarios.findFirst({ where: { igreja_id: a.igreja_id, pessoa_id: u.pessoa_id,
      conta_atuacao: true, id: { not: u.id } }, select: { id: true } })) throw indisponivel();
    const hoje = new Date(await hojeDaIgreja(tx, a.igreja_id));
    const restritos = u.perfil !== 'COMUM' && !!await tx.competencia_secretaria.findFirst({ where: { igreja_id: a.igreja_id,
      contexto_id: reuniao.contexto_id, usuario_id: u.id, pessoa_id: u.pessoa_id!,
      inicio: { lte: hoje }, OR: [{ fim: null }, { fim: { gt: hoje } }], pode_consultar_restritos: true } });
    if (reuniao.restrito && !restritos) throw new NotFoundException('Reunião indisponível.');
    const dados = await tx.mesa_assembleia.findUniqueOrThrow({ where: { id: mesa.id }, include: composicao });
    const r = reuniaoDadosSchema.parse(reuniao.dados);
    if (!['EM_ANDAMENTO', 'ENCERRADA'].includes(r.situacao ?? '')) throw indisponivel();
    return { ...dados, restritos };
  }

  opcoes(a: AtorSecretaria, id: string) {
    return this.db.$transaction(
      async (tx) => {
        const mesa = await this.presidencia(tx, a, id);
        const versoes = await tx.documento_versao.findMany({
          where: {
            igreja_id: a.igreja_id,
            reuniao_id: id,
            congelado_em: null,
            documento: { tipo: 'ATA', estado: 'EM_EDICAO', ...(!mesa.restritos && { restrito: false }) },
          },
          select: {
            id: true,
            numero: true,
            assunto: true,
            modelo: { select: { configuracao: true } },
            documento: { select: { versao_atual: true, revisao: true, encaminhado_em: true } },
            acessos_assembleia: {
              where: { revogado_em: null, mesa_id: mesa.id },
              select: { id: true, expira_em: true, consumido_em: true },
              take: 1,
            },
          },
        });
        return {
          mesa_id: mesa.id,
          secretario: mesa.secretario_nome,
          atas: versoes
            .filter((v) => v.numero === v.documento.versao_atual && this.permite(v.modelo?.configuracao))
            .map((v) => ({
              id: v.id,
              assunto: v.assunto,
              revisao: v.documento.revisao,
              encaminhada: !!v.documento.encaminhado_em,
              acesso: v.acessos_assembleia[0] ?? null,
            })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private permite(config: unknown) {
    const regra = configuracaoSchema.safeParse(config);
    return (
      regra.success &&
      !!regra.data.atuacao &&
      [...regra.data.atuacao.criar, ...regra.data.atuacao.preparar].includes('SECRETARIO_MESA')
    );
  }

  conceder(a: AtorSecretaria, id: string, body: unknown) {
    const v = validar(
      z.strictObject({
        mesa_id: z.uuid(),
        versao_id: z.uuid(),
        idempotencia: z.uuid(),
        expira_em: z.iso.datetime({ offset: true }),
        reabrir_revisao: z.number().int().positive().optional(),
      }),
      body,
    );
    return transacaoComRetentativa(
      this.db,
      async (tx) => {
        const m = await this.presidencia(tx, a, id);
        const expira = new Date(v.expira_em);
        if (m.id !== v.mesa_id || expira <= new Date())
          throw new ConflictException('Confira a composição da mesa e o prazo do acesso.');
        const versao = await tx.documento_versao.findFirst({
          where: {
            id: v.versao_id,
            reuniao_id: id,
            igreja_id: a.igreja_id,
            congelado_em: null,
            documento: { estado: 'EM_EDICAO', tipo: 'ATA', ...(!m.restritos && { restrito: false }) },
          },
          include: { documento: true, modelo: true },
        });
        if (!versao || versao.numero !== versao.documento.versao_atual || !this.permite(versao.modelo?.configuracao))
          throw new BadRequestException('Escolha uma minuta desta sessão cujo modelo autorize o secretário da mesa.');
        const email = normalizarEmail(m.secretario.email);
        const contaInvalida = () => new BadRequestException('Confira o e-mail individual e a situação da conta do secretário eleito.');
        if (!z.email().safeParse(email).success) throw contaInvalida();
        const u = contaDoConvite(m.secretario.usuarios, email, contaInvalida);
        const escolhida = m.secretario.usuarios.find(c => c.conta_atuacao);
        if (u && (['AUDITOR','ADMINISTRADOR'].includes(u.perfil) ||
            (escolhida ? escolhida.id !== u.id : u.perfil === 'COMUM'))) throw contaInvalida();
        if (
          (await tx.pessoas.count({
            where: {
              igreja_id: a.igreja_id,
              id: { not: m.secretario_id },
              email: { equals: email, mode: 'insensitive' },
            },
          })) ||
          (await tx.usuarios.count({
            where: {
              igreja_id: a.igreja_id,
              email_login: { equals: email, mode: 'insensitive' },
              ...(u ? { id: { not: u.id } } : {}),
            },
          }))
        )
          throw new BadRequestException('Informe um e-mail individual vinculado somente ao secretário eleito.');
        const anterior = await tx.acesso_assembleia.findUnique({
          where: { solicitacao: v.idempotencia },
          include: { atos: { where: { operacao: 'REABERTURA' }, select: { revisao: true }, take: 1 } },
        });
        if (anterior) {
          if (
            anterior.atos[0]?.revisao !== v.reabrir_revisao ||
            anterior.concedido_por !== a.sub ||
            anterior.mesa_id !== m.id ||
            anterior.versao_id !== v.versao_id ||
            anterior.expira_em.getTime() !== expira.getTime() ||
            anterior.revogado_em
          )
            throw new ConflictException('Convite anterior incompatível.');
          return { id: anterior.id };
        }
        if (v.reabrir_revisao !== undefined) {
          if (!versao.documento.encaminhado_em || versao.documento.revisao !== v.reabrir_revisao)
            throw new ConflictException('Confira a revisão que será reaberta.');
          await tx.documento_versao.update({ where: { id: versao.id }, data: { revisao_conteudo: { increment: 1 } } });
          await tx.documento.update({
            where: { id: versao.documento_id },
            data: { revisao: { increment: 1 }, encaminhado_em: null },
          });
        }
        await tx.acesso_assembleia.updateMany({
          where: { versao_id: v.versao_id, revogado_em: null },
          data: { revogado_em: new Date() },
        });
        const token = randomBytes(32).toString('hex');
        const acesso = await tx.acesso_assembleia.create({
          data: {
            mesa_id: m.id,
            versao_id: v.versao_id,
            reuniao_id: id,
            igreja_id: a.igreja_id,
            contexto_id: m.contexto_id,
            solicitacao: v.idempotencia,
            conta_id: u?.id,
            conta_versao: u?.auth_version,
            email,
            concedido_por: a.sub,
            hash: hash(token),
            expira_em: expira,
          },
        });
        if (v.reabrir_revisao)
          await tx.ato_acesso_assembleia.create({
            data: { acesso_id: acesso.id, operacao: 'REABERTURA', revisao: v.reabrir_revisao },
          });
        await this.fila.enqueueAssembly(tx, acesso.id, token);
        return { id: acesso.id };
      },
      Prisma.TransactionIsolationLevel.Serializable,
      (erro) => erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002',
    );
  }

  revogar(a: AtorSecretaria, id: string, acesso: string) {
    return transacaoSerializavel(this.db, async (tx) => {
      const mesa = await this.presidencia(tx, a, id);
      const r = await tx.acesso_assembleia.updateMany({
        where: { id: acesso, mesa_id: mesa.id, revogado_em: null },
        data: { revogado_em: new Date() },
      });
      if (!r.count) throw new NotFoundException('Convite indisponível nesta mesa.');
      return { id: acesso };
    });
  }

  private async validar(tx: Tx, token: string | undefined, normal: string | undefined, ativacao: boolean) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) throw indisponivel();
    const g = await tx.acesso_assembleia.findUnique({
      where: ativacao ? { hash: hash(token) } : { sessao_hash: hash(token) },
      include: { mesa: { include: composicao }, versao: { include: { documento: true, reuniao: { include: { contexto: { include: { orgao: true } } } } } } },
    });
    if (
      !g ||
      g.revogado_em ||
      g.expira_em <= new Date() ||
      (ativacao && g.consumido_em) ||
      !recursoDaIgreja('secretaria', g.igreja_id) ||
      g.versao.documento.estado !== 'EM_EDICAO' ||
      g.versao.documento.versao_atual !== g.versao.numero ||
      g.versao.congelado_em
    )
      throw indisponivel();
    const sessaoDaAta = g.versao.reuniao;
    if (!sessaoDaAta || sessaoDaAta.id !== g.reuniao_id || sessaoDaAta.igreja_id !== g.igreja_id ||
        sessaoDaAta.contexto_id !== g.contexto_id || sessaoDaAta.contexto.orgao.tipo !== 'ASSEMBLEIA_GERAL' ||
        !sessaoDaAta.contexto.orgao.ativo) throw indisponivel();
    const vigente = await mesaVigente(tx, sessaoDaAta);
    const reuniao = reuniaoDadosSchema.parse(sessaoDaAta.dados);
    const u = contaDoConvite(g.mesa.secretario.usuarios, g.email, indisponivel);
    const escolhida = g.mesa.secretario.usuarios.find(c => c.conta_atuacao);
    if (
      vigente?.id !== g.mesa_id ||
      !['EM_ANDAMENTO', 'ENCERRADA'].includes(reuniao.situacao ?? '') ||
      g.mesa.secretario.email?.trim().toLowerCase() !== g.email ||
      (u?.id ?? null) !== g.conta_id ||
      (u && (u.auth_version !== g.conta_versao || ['AUDITOR','ADMINISTRADOR'].includes(u.perfil) || (escolhida ? escolhida.id !== u.id : u.perfil === 'COMUM')))
    )
      throw indisponivel();
    if (g.conta_id) {
      if (!normal) throw new UnauthorizedException('Entre com a conta vinculada ao secretário eleito.');
      const sessao = await this.sessions.verify(normal, false);
      if (sessao.id !== g.conta_id || sessao.igreja_id !== g.igreja_id || sessao.mfa_enrollment_required)
        throw new ForbiddenException('Use a conta do secretário eleito com a autenticação concluída.');
    } else if (normal) {
      const sessao = await this.sessions.verify(normal, false).catch(() => null);
      if (sessao) throw new ForbiddenException('Encerre a sessão de outra pessoa antes de usar o convite individual.');
    }
    return g;
  }

  async ativar(convite: unknown, normal?: string) {
    const v = validar(z.strictObject({ token: z.string().regex(/^[0-9a-f]{64}$/) }), convite);
    return transacaoSerializavel(this.db, async (tx) => {
      const g = await this.validar(tx, v.token, normal, true);
      const token = randomBytes(32).toString('hex');
      await tx.acesso_assembleia.update({
        where: { id: g.id },
        data: { consumido_em: new Date(), sessao_hash: hash(token) },
      });
      return { token, id: g.id, expira: g.expira_em };
    });
  }
  async encerrar(token?: string, escopo?: unknown) {
    if (!token || typeof escopo !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
    const resultado = await this.db.acesso_assembleia.updateMany({
      where: { id: escopo, sessao_hash: hash(token) },
      data: { sessao_hash: null },
    });
    return resultado.count === 1;
  }
  async sessao(tx: Tx, c: CredencialAssembleia) {
    const acesso = await this.validar(tx, c.temporaria, c.normal, false);
    if (c.escopo !== acesso.id) throw indisponivel();
    return acesso;
  }
}
