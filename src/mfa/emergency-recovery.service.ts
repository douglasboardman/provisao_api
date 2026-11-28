import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, createPublicKey, verify } from 'crypto';
import { z } from 'zod';
import { PrismaService } from 'src/prisma/prisma.service';

const cleanText = z.string().trim().regex(/^[^\x00-\x1f\x7f]+$/);
export const EmergencyAuthorizationSchema = z.object({
  versao: z.literal(1), igreja_id: z.string().uuid(), usuario_id: z.string().uuid(),
  emitido_em: z.number().int(), expira_em: z.number().int(), nonce: z.string().regex(/^[a-f0-9]{64}$/),
  autoridade: cleanText.min(3).max(120), motivo: cleanText.min(20).max(500), assinatura: z.string().regex(/^[a-zA-Z0-9_-]+$/),
}).strict();
export type EmergencyAuthorization = z.infer<typeof EmergencyAuthorizationSchema>;
export function emergencyMessage(a: EmergencyAuthorization): Buffer {
  return Buffer.from(JSON.stringify(['provisao-mfa-recovery-v1', a.versao, a.igreja_id, a.usuario_id, a.emitido_em, a.expira_em, a.nonce, a.autoridade, a.motivo]), 'utf8');
}

/** Uso somente por CLI operacional offline; não é exposto em rotas HTTP. */
@Injectable()
export class EmergencyRecoveryService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}
  async recover(input: unknown): Promise<void> {
    const parsed = EmergencyAuthorizationSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Autorização inválida.');
    const a = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    if (a.emitido_em > now + 60 || a.emitido_em < now - 600 || a.expira_em <= now || a.expira_em <= a.emitido_em || a.expira_em - a.emitido_em > 600) throw new UnauthorizedException('Autorização inválida ou expirada.');
    let publicKey;
    try { publicKey = createPublicKey(this.config.get<string>('MFA_RECOVERY_PUBLIC_KEY') ?? ''); }
    catch { throw new UnauthorizedException('Chave pública de recuperação indisponível.'); }
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new UnauthorizedException('Chave pública de recuperação inválida.');
    const signature = Buffer.from(a.assinatura, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== a.assinatura || !verify(null, emergencyMessage(a), publicKey, signature)) throw new UnauthorizedException('Autorização inválida ou expirada.');
    const nonceHash = createHash('sha256').update(a.nonce, 'utf8').digest('hex');
    const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    try {
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${a.igreja_id} FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${a.usuario_id} AND igreja_id = ${a.igreja_id} FOR UPDATE`;
        if (a.expira_em <= Math.floor(Date.now() / 1000)) throw new UnauthorizedException('Autorização inválida ou expirada.');
        if (await tx.mfa_recuperacao_emergencial.findUnique({ where: { nonce_hash: nonceHash } })) throw new ConflictException('Autorização já utilizada.');
        const user = await tx.usuarios.findFirst({ where: { id: a.usuario_id, igreja_id: a.igreja_id, ativo: true, perfil: { in: ['ADMINISTRADOR', 'AUDITOR', 'COMUM'] } }, include: { mfa_credencial: true } });
        if (!user || user.mfa_credencial?.estado !== 'ATIVO') throw new BadRequestException('Conta ou MFA indisponível para recuperação.');
        const record = await tx.mfa_recuperacao_emergencial.create({ data: { igreja_id: a.igreja_id, usuario_id: a.usuario_id, nonce_hash: nonceHash, chave_fingerprint: fingerprint, autoridade_externa: a.autoridade, motivo: a.motivo } });
        await tx.mfa_recuperacao_pendente.deleteMany({ where: { usuario_id: user.id } });
        await tx.mfa_recuperacao.deleteMany({ where: { usuario_id: user.id } });
        await tx.mfa_credencial.delete({ where: { usuario_id: user.id } });
        await tx.sessoes.updateMany({ where: { usuario_id: user.id, revogada_em: null }, data: { revogada_em: new Date() } });
        await tx.token_senha.updateMany({ where: { usuario_id: user.id, consumido_em: null, revogado_em: null }, data: { revogado_em: new Date() } });
        await tx.usuarios.update({ where: { id: user.id }, data: { auth_version: { increment: 1 }, mfa_reinscricao_obrigatoria: true } });
        // usuario_id é o alvo: a autoridade é externa e identificada pela chave e pelo registro assinado.
        await tx.logs_atividades.create({ data: { igreja_id: a.igreja_id, usuario_id: user.id, acao: 'ATUALIZACAO', tabela_afetada: 'mfa_recuperacao_emergencial', registro_id: record.id, dados_novos: { alvo_usuario_id: user.id, autoridade_externa: a.autoridade, chave_fingerprint: fingerprint, reinscricao_obrigatoria: true } } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Autorização já utilizada.');
      throw error;
    }
  }
}
