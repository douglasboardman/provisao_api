import { exigirServicoNaTransacao } from '../autorizacao/escrita-servico';
import type { Ator } from '../autorizacao/politica';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, logs_atividades_acao, usuarios_perfil } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { cancelToken } from './cancel-token';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { AccessAuthorityService } from './access-authority.service';
import { OutboxService } from 'src/outbox/outbox.service';
import { solicitacaoDisponivel } from '../feature-flags/feature-flags';

@Injectable()
export class AccessRequestsService {
  private readonly logger = new Logger(AccessRequestsService.name);
  constructor(private readonly prisma: PrismaService, private readonly outbox: OutboxService, private readonly authority: AccessAuthorityService) {}

  async requestAccess(igrejaId: string, nome: string, email: string) {
    const response = { message: 'Se os dados puderem ser processados, enviaremos uma confirmação ao e-mail informado.' };
    if (!solicitacaoDisponivel(igrejaId)) return response;
    try {
      await this.prisma.$transaction(async tx => {
        if (!await tx.igreja.findFirst({ where: { id: igrejaId, ativa: true }, select: { id: true } })) return;
        const accounts = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM usuarios WHERE igreja_id = ${igrejaId} AND lower(btrim(email_login)) = lower(btrim(${email})) LIMIT 1`;
        if (accounts.length) return;
        const pending = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM solicitacao_acesso WHERE igreja_id = ${igrejaId} AND lower(btrim(email_login)) = lower(btrim(${email})) AND estado IN ('AGUARDA_CONFIRMACAO', 'EM_ANALISE') LIMIT 2`;
        if (pending.length > 1) return;
        let request = pending.length ? await tx.solicitacao_acesso.findUnique({ where: { id: pending[0].id } }) : null;
        if (request) {
          await tx.$queryRaw`SELECT id FROM solicitacao_acesso WHERE id = ${request.id} FOR UPDATE`;
          request = await tx.solicitacao_acesso.findUniqueOrThrow({ where: { id: request.id } });
          if (request.estado !== 'AGUARDA_CONFIRMACAO') return;
          const latest = await tx.confirmacao_acesso.findFirst({ where: { solicitacao_id: request.id }, orderBy: { created_at: 'desc' } });
          if (latest && Date.now() - latest.created_at.getTime() < 60_000) return;
          await tx.confirmacao_acesso.updateMany({ where: { solicitacao_id: request.id, consumido_em: null, revogado_em: null }, data: { revogado_em: new Date() } });
        } else {
          request = await tx.solicitacao_acesso.create({ data: { igreja_id: igrejaId, nome_usuario: nome, email_login: email } });
        }
        const token = randomBytes(32).toString('hex');
        const hash = createHash('sha256').update(token).digest('hex');
        const cancelHash = createHash('sha256').update(cancelToken(token)).digest('hex');
        const confirmation = await tx.confirmacao_acesso.create({ data: { solicitacao_id: request.id, hash, cancelamento_hash: cancelHash, expira_em: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
        await this.outbox.enqueueConfirmation(tx, confirmation.id, token);
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) this.logger.warn('Falha ao processar solicitação de acesso.');
    }
    return response;
  }

  async confirm(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('Confirmação inválida ou expirada.');
    const hash = createHash('sha256').update(token).digest('hex');
    await this.prisma.$transaction(async tx => {
      const confirmation = await tx.confirmacao_acesso.findUnique({ where: { hash } });
      if (!confirmation) throw new UnauthorizedException('Confirmação inválida ou expirada.');
      await tx.$queryRaw`SELECT id FROM solicitacao_acesso WHERE id = ${confirmation.solicitacao_id} FOR UPDATE`;
      const request = await tx.solicitacao_acesso.findUnique({ where: { id: confirmation.solicitacao_id } });
      if (!request || request.estado !== 'AGUARDA_CONFIRMACAO') throw new UnauthorizedException('Confirmação inválida ou expirada.');
      const consumed = await tx.confirmacao_acesso.updateMany({ where: { id: confirmation.id, consumido_em: null, revogado_em: null, expira_em: { gt: new Date() } }, data: { consumido_em: new Date() } });
      if (consumed.count !== 1) throw new UnauthorizedException('Confirmação inválida ou expirada.');
      await tx.solicitacao_acesso.update({ where: { id: request.id }, data: { estado: 'EM_ANALISE' } });
    });
    return { message: 'E-mail confirmado. Sua solicitação aguarda análise.' };
  }

  async cancel(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('Cancelamento inválido ou expirado.');
    const hash = createHash('sha256').update(token).digest('hex');
    await this.prisma.$transaction(async tx => {
      const confirmation = await tx.confirmacao_acesso.findUnique({ where: { cancelamento_hash: hash } });
      if (!confirmation) throw new UnauthorizedException('Cancelamento inválido ou expirado.');
      await tx.$queryRaw`SELECT id FROM solicitacao_acesso WHERE id = ${confirmation.solicitacao_id} FOR UPDATE`;
      const access = await tx.solicitacao_acesso.findUnique({ where: { id: confirmation.solicitacao_id } });
      const current = await tx.confirmacao_acesso.findUnique({ where: { id: confirmation.id } });
      if (!access || !['AGUARDA_CONFIRMACAO', 'EM_ANALISE'].includes(access.estado) || !current || current.revogado_em || current.expira_em <= new Date()) throw new UnauthorizedException('Cancelamento inválido ou expirado.');
      await tx.solicitacao_acesso.update({ where: { id: access.id }, data: { estado: 'CANCELADA' } });
      await tx.confirmacao_acesso.updateMany({ where: { solicitacao_id: access.id, revogado_em: null }, data: { revogado_em: new Date() } });
    });
    return { message: 'Solicitação cancelada.' };
  }

  list(igrejaId: string, actorId: string, rawPage?: string) {
    if (rawPage !== undefined && !/^[1-9][0-9]{0,5}$/.test(rawPage)) throw new BadRequestException('Página inválida.');
    const page = rawPage ? Number(rawPage) : 1;
    return this.prisma.$transaction(async tx => {
      await this.authority.assertReviewer(tx, igrejaId, actorId, 'ACESSO_CONSULTAR');
      return tx.solicitacao_acesso.findMany({ where: { igreja_id: igrejaId }, select: { id: true, nome_usuario: true, email_login: true, estado: true, situacao_acesso: true, created_at: true }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], skip: (page - 1) * 100, take: 100 });
    });
  }

  async decide(id: string, igrejaId: string, actorId: string, approve: boolean, ator?: Ator) {
    const placeholder = approve ? await bcrypt.hash(randomBytes(32).toString('hex'), 10) : undefined;
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM solicitacao_acesso WHERE id = ${id} AND igreja_id = ${igrejaId} FOR UPDATE`;
        const request = await tx.solicitacao_acesso.findFirst({ where: { id, igreja_id: igrejaId } });
        if (!request) throw new NotFoundException('Solicitação não encontrada.');
        if (request.estado !== 'EM_ANALISE') throw new BadRequestException('Solicitação não está em análise.');
        await exigirServicoNaTransacao(tx, ator, 'ACESSO_ANALISAR');
        const actor = await this.authority.assertReviewer(tx, igrejaId, actorId);
        const self = await tx.$queryRaw<{ is_same: boolean }[]>`SELECT lower(btrim(${actor.email_login})) = lower(btrim(${request.email_login})) AS is_same`;
        if (self[0]?.is_same) throw new UnauthorizedException('Ação não autorizada.');
        let userId: string | null = null;
        if (approve) {
          const user = await tx.usuarios.create({ data: { igreja_id: igrejaId, nome_usuario: request.nome_usuario, email_login: request.email_login, senha_hash: placeholder!, perfil: usuarios_perfil.COMUM, ativo: true } });
          userId = user.id;
          const raw = randomBytes(32).toString('hex');
          const token = await tx.token_senha.create({ data: { usuario_id: user.id, hash: createHash('sha256').update(raw).digest('hex'), finalidade: 'password_setup', auth_version: user.auth_version, expira_em: new Date(Date.now() + 48 * 60 * 60 * 1000) } });
          await this.outbox.enqueue(tx, token.id, raw);
        }
        await tx.solicitacao_acesso.update({ where: { id }, data: { estado: approve ? 'APROVADA' : 'REJEITADA', situacao_acesso: approve ? 'CONVITE_PENDENTE' : null, usuario_id: userId, analisado_por: actorId, analisado_em: new Date() } });
        await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: actorId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'solicitacao_acesso', registro_id: id, dados_novos: { estado: approve ? 'APROVADA' : 'REJEITADA', usuario_id: userId } } });
        return { message: approve ? 'Aprovação registrada; convite enfileirado.' : 'Solicitação rejeitada.' };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Já existe uma conta para este e-mail na igreja.');
      throw error;
    }
  }
}
