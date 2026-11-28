import { exigirServicoDoUsuario } from '../autorizacao/operacao-atual';
import { createHash, randomBytes } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
const texto = z.string().trim().min(1).max(1000);
const conviteSchema = z.object({ destino_igreja_id: z.string().uuid(), autoridade: z.string().trim().min(1).max(255), evidencia: texto }).strict();
const receberSchema = z.object({ codigo: z.string().regex(/^[a-f0-9]{64}$/), autoridade: z.string().trim().min(1).max(255), evidencia: texto }).strict();
const revogarSchema = z.object({ motivo: texto }).strict();
type Tx = Prisma.TransactionClient;

/** A referência é declarada e conferida localmente. Ela não concede acesso entre igrejas. */
@Injectable()
export class IdentidadePastoralService {
  constructor(private readonly prisma: PrismaService) {}
  private async autorizar(tx: Tx, igreja: string, usuario: string) {
    const operador = await exigirServicoDoUsuario(tx, igreja, usuario, 'OFICIAIS_REGISTRAR');
    if (!operador) throw new ForbiddenException('Operador não autorizado nesta igreja.');
  }
  private async docente(tx: Tx, igreja: string, oficialId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string; tipo: string }>>`SELECT id, tipo FROM oficial WHERE id = ${oficialId} AND igreja_id = ${igreja} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Oficial não encontrado nesta igreja.');
    if (rows[0].tipo !== 'PRESBITERO_DOCENTE') throw new BadRequestException('A referência exige presbítero docente.');
  }
  private async auditar(tx: Tx, igreja: string, usuario: string, tabela: string, id: string, acao: logs_atividades_acao) {
    await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao, tabela_afetada: tabela, registro_id: id } });
  }
  async local(igreja: string, usuario: string, oficialId: string) {
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario);
      const oficial = await tx.oficial.findFirst({ where: { id: oficialId, igreja_id: igreja, tipo: 'PRESBITERO_DOCENTE' }, select: { id: true } });
      if (!oficial) throw new NotFoundException('Docente não encontrado nesta igreja.');
      const referencia = await tx.referencia_identidade_pastoral.findFirst({ where: { igreja_id: igreja, oficial_id: oficialId, revogado_em: null }, select: { id: true, criado_em: true } });
      return { referencia };
    });
  }
  async convidar(igreja: string, usuario: string, oficialId: string, dados: z.infer<typeof conviteSchema>) {
    const parsed = conviteSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Dados do convite inválidos.');
    const v = parsed.data;
    if (v.destino_igreja_id === igreja) throw new BadRequestException('A igreja de destino deve ser diferente.');
    const codigo = randomBytes(32).toString('hex'), hash = createHash('sha256').update(codigo).digest('hex');
    const expiracao = await this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario); await this.docente(tx, igreja, oficialId);
      const destino = await tx.igreja.findFirst({ where: { id: v.destino_igreja_id, ativa: true }, select: { id: true } });
      if (!destino) throw new NotFoundException('Igreja de destino indisponível.');
      let referencia = await tx.referencia_identidade_pastoral.findFirst({ where: { igreja_id: igreja, oficial_id: oficialId, revogado_em: null } });
      if (referencia) {
        await tx.$queryRaw`SELECT id FROM referencia_identidade_pastoral WHERE id = ${referencia.id} AND igreja_id = ${igreja} AND revogado_em IS NULL FOR UPDATE`;
        referencia = await tx.referencia_identidade_pastoral.findFirst({ where: { id: referencia.id, igreja_id: igreja, revogado_em: null } });
        if (!referencia) throw new ConflictException('A referência local mudou; tente novamente.');
      } else {
        const identidade = await tx.identidade_pastoral.create({ data: {} });
        referencia = await tx.referencia_identidade_pastoral.create({ data: { igreja_id: igreja, oficial_id: oficialId, identidade_id: identidade.id, autoridade: v.autoridade, evidencia: v.evidencia, criado_por_id: usuario } });
        await this.auditar(tx, igreja, usuario, 'referencia_identidade_pastoral', referencia.id, logs_atividades_acao.CRIACAO);
      }
      await tx.convite_identidade_pastoral.updateMany({ where: { origem_referencia_id: referencia.id, destino_igreja_id: v.destino_igreja_id, consumido_em: null, revogado_em: null }, data: { revogado_em: new Date() } });
      const [{ agora }] = await tx.$queryRaw<Array<{ agora: Date }>>`SELECT CURRENT_TIMESTAMP AS agora`;
      const expiraEm = new Date(agora.getTime() + 15 * 60 * 1000);
      const convite = await tx.convite_identidade_pastoral.create({ data: { identidade_id: referencia.identidade_id, origem_igreja_id: igreja, destino_igreja_id: v.destino_igreja_id, origem_referencia_id: referencia.id, criado_por_id: usuario, autoridade: v.autoridade, evidencia: v.evidencia, token_hash: hash, expira_em: expiraEm } });
      await this.auditar(tx, igreja, usuario, 'convite_identidade_pastoral', convite.id, logs_atividades_acao.CRIACAO);
      return expiraEm;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { codigo, expira_em: expiracao };
  }
  async receber(igreja: string, usuario: string, oficialId: string, dados: z.infer<typeof receberSchema>) {
    const parsed = receberSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Dados da referência inválidos.');
    const v = parsed.data, hash = createHash('sha256').update(v.codigo).digest('hex');
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario);
      const inicial = await tx.convite_identidade_pastoral.findFirst({ where: { token_hash: hash, destino_igreja_id: igreja }, select: { id: true, origem_referencia_id: true } });
      if (!inicial) throw new BadRequestException('Código inválido ou indisponível.');
      // Mesma ordem de bloqueio da revogação: referência de origem, depois convite.
      const origem = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM referencia_identidade_pastoral WHERE id = ${inicial.origem_referencia_id} AND revogado_em IS NULL FOR SHARE`;
      if (!origem.length) throw new BadRequestException('Código inválido ou indisponível.');
      const convites = await tx.$queryRaw<Array<{ id: string; identidade_id: string }>>`SELECT id, identidade_id FROM convite_identidade_pastoral WHERE id = ${inicial.id} AND destino_igreja_id = ${igreja} AND token_hash = ${hash} AND consumido_em IS NULL AND revogado_em IS NULL AND expira_em > clock_timestamp() FOR UPDATE`;
      if (!convites.length) throw new BadRequestException('Código inválido ou indisponível.');
      await this.docente(tx, igreja, oficialId);
      const existente = await tx.referencia_identidade_pastoral.findFirst({ where: { igreja_id: igreja, oficial_id: oficialId, revogado_em: null }, select: { id: true } });
      if (existente) throw new ConflictException('O docente já possui referência ativa nesta igreja.');
      const referencia = await tx.referencia_identidade_pastoral.create({ data: { igreja_id: igreja, oficial_id: oficialId, identidade_id: convites[0].identidade_id, autoridade: v.autoridade, evidencia: v.evidencia, criado_por_id: usuario } });
      await tx.convite_identidade_pastoral.update({ where: { id: convites[0].id }, data: { destino_referencia_id: referencia.id, consumido_em: new Date() } });
      await this.auditar(tx, igreja, usuario, 'referencia_identidade_pastoral', referencia.id, logs_atividades_acao.CRIACAO);
      return { id: referencia.id, criado_em: referencia.criado_em };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
  async revogar(igreja: string, usuario: string, oficialId: string, dados: z.infer<typeof revogarSchema>) {
    const parsed = revogarSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Motivo inválido.');
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario); await this.docente(tx, igreja, oficialId);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM referencia_identidade_pastoral WHERE igreja_id = ${igreja} AND oficial_id = ${oficialId} AND revogado_em IS NULL FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Referência local ativa não encontrada.');
      await tx.convite_identidade_pastoral.updateMany({ where: { origem_referencia_id: rows[0].id, consumido_em: null, revogado_em: null }, data: { revogado_em: new Date() } });
      await tx.referencia_identidade_pastoral.update({ where: { id: rows[0].id }, data: { revogado_em: new Date(), revogado_por_id: usuario, motivo_revogacao: parsed.data.motivo } });
      await this.auditar(tx, igreja, usuario, 'referencia_identidade_pastoral', rows[0].id, logs_atividades_acao.ATUALIZACAO);
      return { revogada: true };
    });
  }
}
