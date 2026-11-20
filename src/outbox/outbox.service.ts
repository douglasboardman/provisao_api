import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { cancelToken } from 'src/access-requests/cancel-token';
import { EmailService } from 'src/email/email.service';
import { assinaturasDisponiveis } from 'src/secretaria/expedicao-estado';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly email: EmailService) {}

  private key(): Buffer {
    const value = this.config.get<string>('EMAIL_OUTBOX_KEY');
    if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new InternalServerErrorException('Chave da fila de e-mail não configurada.');
    return Buffer.from(value, 'hex');
  }
  seal(token: string, tokenId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(tokenId));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64url')).join('.');
  }
  private unseal(payload: string, tokenId: string): string {
    const parts = payload.split('.');
    if (parts.length !== 3) throw new Error('payload inválido');
    const [iv, tag, encrypted] = parts.map(v => Buffer.from(v, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(tokenId));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
  }
  async enqueue(tx: Prisma.TransactionClient, tokenId: string, token: string): Promise<void> {
    const payload = this.seal(token, tokenId);
    await tx.outbox_email.create({ data: { token_id: tokenId, payload } });
  }

  async enqueueConfirmation(tx: Prisma.TransactionClient, confirmationId: string, token: string): Promise<void> {
    await tx.outbox_email.create({ data: { confirmacao_id: confirmationId, payload: this.seal(token, confirmationId) } });
  }

  async enqueueSignature(tx: Prisma.TransactionClient, conviteId: string, token: string): Promise<void> {
    await tx.outbox_email.create({ data: { convite_assinatura_id: conviteId, payload: this.seal(token, conviteId) } });
  }

  /** Indicadores restritos à igreja; nunca retorna payload, hash ou links. */
  async summary(churchId: string) {
    const where: Prisma.outbox_emailWhereInput = { OR: [
      { token: { usuario: { igreja_id: churchId } } },
      { confirmacao: { solicitacao: { igreja_id: churchId } } },
    ] };
    const [groups, oldest, failed] = await Promise.all([
      this.prisma.outbox_email.groupBy({ by: ['estado'], where, _count: { _all: true } }),
      this.prisma.outbox_email.findFirst({ where: { ...where, estado: 'PENDENTE' }, orderBy: { created_at: 'asc' }, select: { created_at: true } }),
      this.prisma.outbox_email.findMany({ where: { ...where, estado: 'FALHOU' }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 20, select: {
        created_at: true, tentativas: true,
        token: { select: { finalidade: true, usuario: { select: { email_login: true } } } },
        confirmacao: { select: { solicitacao: { select: { email_login: true } } } },
      } }),
    ]);
    const count = (state: string) => groups.find(item => item.estado === state)?._count._all ?? 0;
    return {
      pendentes: count('PENDENTE'), processando: count('PROCESSANDO'), falhas: count('FALHOU'),
      mais_antigo_pendente: oldest?.created_at ?? null,
      falhas_recentes: failed.map(item => ({ criado_em: item.created_at, tentativas: item.tentativas,
        tipo: item.confirmacao ? 'CONFIRMACAO' : item.token?.finalidade === 'password_setup' ? 'CONVITE' : 'RECUPERACAO',
        destinatario: item.confirmacao?.solicitacao.email_login ?? item.token?.usuario.email_login ?? '',
      })),
    };
  }

  /** Reserva uma tarefa por worker. Envio é pelo menos uma vez após falha de processo. */
  async runOnce(): Promise<boolean> {
    this.key(); // falha fechada antes de reservar tarefas
    const lease = randomUUID();
    const job = await this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM outbox_email
        WHERE (convite_assinatura_id IS NULL OR ${assinaturasDisponiveis()})
          AND ((estado = 'PENDENTE' AND proxima_tentativa <= NOW())
           OR (estado = 'PROCESSANDO' AND reserva_ate < NOW()))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows.length) return null;
      return tx.outbox_email.update({ where: { id: rows[0].id }, data: { estado: 'PROCESSANDO', reserva_id: lease, reserva_ate: new Date(Date.now() + 120_000), tentativas: { increment: 1 } }, include: { token: { include: { usuario: true } }, confirmacao: { include: { solicitacao: true } }, convite_assinatura: { include: {
        usuario: { select: { ativo: true, auth_version: true, pessoa_id: true, email_login: true } },
        arrolado: { select: { pessoa_id: true, retrato: true, pessoa: { select: { email: true } } } },
        expedicao: { select: { estado: true, versao: { select: {
          numero: true, documento: { select: { estado: true, versao_atual: true } },
        } } } },
      } } } });
    });
    if (!job) return false;
    try {
      const signature = job.convite_assinatura;
      const entry = job.token ?? job.confirmacao ?? signature;
      const invalid = !entry || !job.payload || entry.revogado_em || entry.consumido_em || entry.expira_em <= new Date();
      const passwordInvalid = job.token && (!job.token.usuario.ativo || job.token.usuario.auth_version !== job.token.auth_version);
      const confirmationInvalid = job.confirmacao && job.confirmacao.solicitacao.estado !== 'AGUARDA_CONFIRMACAO';
      const signatureInvalid = signature && (signature.recusado_em || signature.expedicao.estado !== 'AGUARDANDO' ||
        signature.arrolado.pessoa.email?.trim().toLowerCase() !== signature.email ||
        signature.expedicao.versao.documento.estado !== 'APROVADO' ||
        signature.expedicao.versao.documento.versao_atual !== signature.expedicao.versao.numero ||
        (signature.usuario && (!signature.usuario.ativo || signature.usuario.auth_version !== signature.auth_version ||
          signature.usuario.pessoa_id !== signature.arrolado.pessoa_id || signature.usuario.email_login.trim().toLowerCase() !== signature.email)));
      if (invalid || passwordInvalid || confirmationInvalid || signatureInvalid) {
        await this.prisma.outbox_email.updateMany({ where: { id: job.id, reserva_id: lease, estado: 'PROCESSANDO' }, data: { estado: 'CANCELADO', payload: null, reserva_id: null, reserva_ate: null } });
        return true;
      }
      const token = this.unseal(job.payload!, entry!.id);
      if (!/^[a-f0-9]{64}$/.test(token) || createHash('sha256').update(token).digest('hex') !== entry!.hash) throw new Error('token inválido');
      const base = this.config.get<string>('FRONTEND_URL');
      if (!base) throw new Error('origem ausente');
      if (signature) {
        const { nome } = signature.arrolado.retrato as { nome: string };
        const url = new URL('/assinaturas/convite', base);
        url.hash = token;
        await this.email.sendSignatureInvitation(nome, signature.email, url.toString(), signature.id, signature.expira_em);
      } else if (job.confirmacao) {
        const { solicitacao, cancelamento_hash, expira_em } = job.confirmacao;
        const url = new URL(`${base}/auth/confirm-access`);
        url.searchParams.set('token', token);
        if (cancelamento_hash) url.searchParams.set('cancel_token', cancelToken(token));
        await this.email.sendAccessConfirmation(solicitacao.nome_usuario, solicitacao.email_login, url.toString(), expira_em);
      } else if (job.token) {
        const { usuario, finalidade, expira_em } = job.token;
        const url = `${base}/auth/set-password?token=${token}`;
        if (finalidade === 'password_setup') {
          await this.email.sendPasswordSetup(usuario.nome_usuario, usuario.email_login, url, expira_em);
        } else if (finalidade === 'password_reset') {
          await this.email.sendPasswordReset(usuario.nome_usuario, usuario.email_login, url, expira_em);
        } else throw new Error('finalidade inválida');
      }
      await this.prisma.outbox_email.updateMany({ where: { id: job.id, reserva_id: lease, estado: 'PROCESSANDO' }, data: { estado: 'ENVIADO', enviado_em: new Date(), payload: null, reserva_id: null, reserva_ate: null, ultimo_erro: null } });
    } catch {
      const final = job.tentativas >= 8;
      const delayMs = Math.min(60 * 60 * 1000, 1000 * 30 * 2 ** Math.min(job.tentativas - 1, 7));
      await this.prisma.outbox_email.updateMany({ where: { id: job.id, reserva_id: lease, estado: 'PROCESSANDO' }, data: { estado: final ? 'FALHOU' : 'PENDENTE', payload: final ? null : job.payload, proxima_tentativa: new Date(Date.now() + delayMs), reserva_id: null, reserva_ate: null, ultimo_erro: 'FALHA_ENVIO_OU_PROCESSAMENTO' } });
    }
    return true;
  }
}
