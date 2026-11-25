import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { LIMITE_ARTEFATO_EXPEDICAO } from '../private-storage/private-storage.service';
import { SessionService } from '../auth/session.service';
import { OutboxService } from '../outbox/outbox.service';
import { transacaoSerializavel } from '../orgaos/idempotencia';
import { hashAto } from '../orgaos/idempotencia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { AtorSecretaria, SecretariaBaseService, Tx, json } from './secretaria-base.service';
import {
  atualAprovada,
  carimbarPdf,
  Expedicao,
  ExpedicaoArquivos,
  incluirExpedicao,
  nomeSignatario,
  sha256,
} from './expedicao-arquivos';
import { revogarConvites } from './expedicao-estado';
import { validar } from './secretaria.dto';
import * as dto from './assinaturas.dto';
import { contaDoConvite, normalizarEmail } from './conta-do-convite';

const pdfInvalido = 'Envie a digitalização como PDF válido, sem senha e com ao menos uma página.';
const conviteInvalido = () => new NotFoundException('Convite indisponível.');
const emailIndividual = z.email().max(255);

@Injectable()
export class AssinaturasService {
  constructor(
    private readonly base: SecretariaBaseService,
    private readonly arquivos: ExpedicaoArquivos,
    private readonly outbox: OutboxService,
    private readonly sessions: SessionService,
  ) {}

  private async expedicaoDoDocumento(tx: Tx, ator: AtorSecretaria, id: string, versaoId: string) {
    await this.base.operador(tx, ator);
    const documento = await this.base.documento(tx, ator, id);
    const e = await tx.expedicao_documento.findFirst({
      where: { versao_id: versaoId, igreja_id: ator.igreja_id, versao: { documento_id: documento.id } },
      include: incluirExpedicao,
    });
    if (!e) throw new NotFoundException('Fluxo de assinatura não encontrado para esta versão.');
    return e;
  }

  private async comandar(tx: Tx, ator: AtorSecretaria, id: string, v: { versao_id: string; revisao: number }) {
    const e = await this.expedicaoDoDocumento(tx, ator, id, v.versao_id);
    const operador = await this.base.competente(tx, ator, e.contexto_id, 'pode_aprovar');
    this.base.conferirRevisao(e.versao.documento.revisao, v.revisao);
    return { e, operador };
  }

  private exigirColeta(e: Expedicao, metodo: Expedicao['modalidade']) {
    if (!atualAprovada(e) || e.modalidade !== metodo || e.estado !== 'AGUARDANDO') {
      throw new ConflictException('A versão atual não está aberta para esta coleta de assinaturas.');
    }
  }

  async listar(ator: AtorSecretaria, id: string) {
    return this.base.prisma.$transaction(
      async (tx) => {
        await this.base.operador(tx, ator);
        await this.base.documento(tx, ator, id);
        const expedicoes = await tx.expedicao_documento.findMany({
          where: { igreja_id: ator.igreja_id, versao: { documento_id: id } },
          include: {
            ...incluirExpedicao,
            convites: {
              orderBy: [{ criado_em: 'desc' }, { id: 'desc' }],
              select: {
                arrolado_id: true,
                expira_em: true,
                revogado_em: true,
                recusado_em: true,
                motivo_recusa: true,
                consumido_em: true,
                outbox: { select: { estado: true } },
              },
            },
          },
        });
        const agora = new Date();
        return expedicoes.map((e) => ({
          versao_id: e.versao_id,
          modalidade: e.modalidade,
          estado: e.estado,
          fuso_iana: e.fuso_iana,
          codigo: e.estado === 'CONCLUIDA' ? e.codigo_verificacao : null,
          matriz_sha256: e.matriz?.sha256 ?? null,
          aceite_sha256: e.aceite_sha256,
          final_sha256: e.arquivo_final?.sha256 ?? null,
          via_sha256: e.via?.sha256 ?? null,
          expedido_em: e.expedido_em,
          conferencia: e.conferencia && {
            operador: e.conferencia.operador_nome,
            data: e.conferencia.conferida_em,
            evidencia: e.conferencia.evidencia,
            sha256: e.conferencia.arquivo.sha256,
          },
          signatarios: e.versao.arrolados.map((a) => {
            const c = e.convites.find((c) => c.arrolado_id === a.id);
            const assinatura = e.assinaturas.find((s) => s.arrolado_id === a.id);
            return {
              id: a.id,
              nome: nomeSignatario(a),
              obrigatorio: a.obrigatorio,
              papeis: a.papeis,
              assinatura: assinatura && {
                data: assinatura.registrada_em,
                metodo: assinatura.metodo,
                evidencias:
                  assinatura.metodo === 'FISICA' ? assinatura.evidencias : { matriz_sha256: e.matriz?.sha256 },
              },
              convite: c && {
                entrega: c.outbox?.estado,
                motivo_recusa: c.motivo_recusa,
                estado: c.consumido_em
                  ? 'ASSINADO'
                  : c.recusado_em
                    ? 'RECUSADO'
                    : c.revogado_em
                      ? 'REVOGADO'
                      : c.expira_em <= agora
                        ? 'EXPIRADO'
                        : 'PENDENTE',
              },
            };
          }),
        }));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async identidadeCanal(tx: Tx, igrejaId: string, pessoaId: string, email: string) {
    const pessoa = await tx.pessoas.findFirst({
      where: { id: pessoaId, igreja_id: igrejaId },
      select: { email: true },
    });
    if (!emailIndividual.safeParse(email).success || normalizarEmail(pessoa?.email) !== email) {
      throw new ConflictException('O e-mail individual deve coincidir com o cadastro atual e com a versão aprovada.');
    }
    const compartilhado = await tx.$queryRaw<{ encontrado: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM pessoas WHERE igreja_id = ${igrejaId} AND id <> ${pessoaId} AND lower(btrim(email)) = ${email}
        UNION ALL
        SELECT 1 FROM usuarios WHERE igreja_id = ${igrejaId} AND pessoa_id IS DISTINCT FROM ${pessoaId}
          AND lower(btrim(email_login)) = ${email}
      ) AS encontrado`;
    if (compartilhado[0].encontrado) throw new ConflictException('O endereço está compartilhado nesta igreja.');
    const contas = await tx.usuarios.findMany({
      where: { igreja_id: igrejaId, pessoa_id: pessoaId },
      select: { id: true, email_login: true, ativo: true, auth_version: true, perfil: true, conta_atuacao: true },
    });
    const conta = contaDoConvite(contas, email, () =>
      new ConflictException('O endereço individual deve corresponder a uma conta vinculada ativa.'),
    );
    if (conta?.perfil === 'COMUM' && !conta.conta_atuacao) throw new ConflictException('Selecione a conta de atuação do signatário.');
    return conta;
  }

  enviarConvite(ator: AtorSecretaria, id: string, dados: unknown) {
    const v = validar(dto.enviarConviteSchema, dados);
    return this.base.comando(ator, 'CONVIDAR_SIGNATARIO_DOCUMENTO', id, v, async (tx) => {
      const { e } = await this.comandar(tx, ator, id, v);
      this.exigirColeta(e, 'ELETRONICA');
      const a = e.versao.arrolados.find((a) => a.id === v.arrolado_id);
      if (!a || e.assinaturas.some((s) => s.arrolado_id === a.id))
        throw new ConflictException('Signatário indisponível.');
      const recusado = await tx.convite_assinatura.findFirst({
        where: { arrolado_id: a.id, recusado_em: { not: null } },
      });
      if (recusado) throw new ConflictException('A recusa exige substituição formal da versão para uma nova coleta.');
      const anterior = await tx.convite_assinatura.findFirst({
        where: { arrolado_id: a.id, revogado_em: null },
        orderBy: [{ criado_em: 'desc' }, { id: 'desc' }],
        include: { outbox: true },
      });
      if (anterior && anterior.outbox?.estado !== 'FALHOU' && anterior.criado_em.getTime() > Date.now() - 60_000) {
        throw new ConflictException('Aguarde um minuto antes de reenviar.');
      }
      const email = normalizarEmail((a.retrato as { email?: string | null }).email);
      const conta = await this.identidadeCanal(tx, e.igreja_id, a.pessoa_id, email);
      await this.arquivos.vincularMatriz(tx, e);
      await revogarConvites(tx, e.versao_id, a.id);
      const token = randomBytes(32).toString('hex');
      const convite = await tx.convite_assinatura.create({
        data: {
          igreja_id: e.igreja_id,
          contexto_id: e.contexto_id,
          versao_id: e.versao_id,
          arrolado_id: a.id,
          usuario_id: conta?.id,
          auth_version: conta?.auth_version,
          email,
          hash: sha256(token),
          expira_em: new Date(Date.now() + 48 * 60 * 60_000),
        },
      });
      await this.outbox.enqueueSignature(tx, convite.id, token);
      return { id, convite_id: convite.id };
    });
  }

  revogar(ator: AtorSecretaria, id: string, dados: unknown) {
    const v = validar(dto.revogarConviteSchema, dados);
    return this.base.comando(ator, 'REVOGAR_CONVITE_DOCUMENTO', id, v, async (tx) => {
      const { e } = await this.comandar(tx, ator, id, v);
      this.exigirColeta(e, 'ELETRONICA');
      if (!e.versao.arrolados.some((a) => a.id === v.arrolado_id))
        throw new NotFoundException('Signatário indisponível.');
      await revogarConvites(tx, e.versao_id, v.arrolado_id);
      return { id };
    });
  }

  criarVia(ator: AtorSecretaria, id: string, dados: unknown) {
    const v = validar(dto.processoSchema, dados);
    const arquivoId = randomUUID();
    return this.base.comando(ator, 'CRIAR_VIA_DOCUMENTO', id, v, async (tx) => {
      const { e } = await this.comandar(tx, ator, id, v);
      const derivacao =
        e.modalidade === 'ELETRONICA' && e.estado === 'CONCLUIDA' && e.versao.documento.estado === 'EXPEDIDO';
      if (!derivacao) this.exigirColeta(e, 'FISICA');
      if (e.via_id) return { id };
      const { matriz } = await this.arquivos.vincularMatriz(tx, e);
      const bytes = await this.arquivos.storage.readVerified(matriz);
      const via = await carimbarPdf(
        bytes,
        derivacao
          ? 'DERIVAÇÃO PARA COLETA FÍSICA - SEM ASSINATURAS FÍSICAS'
          : 'VIA APROVADA PARA COLETA FÍSICA - ASSINATURAS PENDENTES',
      );
      const arquivo = await this.arquivos.storage.saveArtifact(tx, ator, arquivoId, via, LIMITE_ARTEFATO_EXPEDICAO);
      await tx.expedicao_documento.update({ where: { id: e.id }, data: { via_id: arquivo.id } });
      return { id };
    });
  }

  async conferir(ator: AtorSecretaria, id: string, dados: unknown, bytes: Buffer | undefined) {
    if (!bytes?.length || bytes.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException(pdfInvalido);
    const v = validar(dto.conferenciaSchema, dados);
    const comando = { ...v, scan_sha256: sha256(bytes) };
    const arquivoId = randomUUID();
    return this.base.comando(ator, 'CONFERIR_SCAN_DOCUMENTO', id, comando, async (tx) => {
      const { e, operador } = await this.comandar(tx, ator, id, v);
      this.exigirColeta(e, 'FISICA');
      if (!e.via || e.via.sha256 !== v.via_sha256 || !e.aceite_sha256) {
        throw new ConflictException('Use a via aprovada arquivada desta versão.');
      }
      if (comando.scan_sha256 === e.via.sha256 || comando.scan_sha256 === e.matriz?.sha256) {
        throw new BadRequestException('Envie a digitalização das assinaturas coletadas.');
      }
      await this.arquivos.storage.readVerified(e.via);
      await this.arquivos.verificarAceite(e);
      const pdf = await PDFDocument.load(bytes).catch(() => {
        throw new BadRequestException(pdfInvalido);
      });
      const paginas = pdf.getPageCount();
      if (!paginas) throw new BadRequestException(pdfInvalido);
      const reserva = e.versao.registro_livro;
      if (reserva && paginas !== reserva.posicao_fim - reserva.posicao_inicio + 1) {
        throw new BadRequestException('A digitalização deve ter o mesmo número de faces da reserva.');
      }
      const assinadas = new Set(v.assinaturas.map((a) => a.arrolado_id));
      const signatarios = e.versao.arrolados;
      const obrigatorios = signatarios.filter((a) => a.obrigatorio);
      if (
        !obrigatorios.length ||
        !obrigatorios.every((a) => assinadas.has(a.id)) ||
        !v.assinaturas.every((a) => signatarios.some((s) => s.id === a.arrolado_id))
      ) {
        throw new BadRequestException('Confira todos os signatários obrigatórios da versão.');
      }
      const hoje = await hojeDaIgreja(tx, ator.igreja_id);
      const dataDocumento = e.versao.data_documento.toISOString().slice(0, 10);
      if (v.assinaturas.some((a) => a.data > hoje || a.data < dataDocumento)) {
        throw new BadRequestException('A data da assinatura física deve estar entre a data do documento e hoje.');
      }
      const arquivo = await this.arquivos.storage.saveArtifact(tx, ator, arquivoId, bytes);
      const escopo = { igreja_id: e.igreja_id, contexto_id: e.contexto_id, versao_id: e.versao_id };
      await tx.conferencia_fisica.create({
        data: {
          ...escopo,
          arquivo_id: arquivo.id,
          operador_id: ator.sub,
          operador_nome: operador.nome_usuario,
          evidencia: v.evidencia,
        },
      });
      await tx.assinatura_documento.createMany({
        data: v.assinaturas.map((a) => ({
          ...escopo,
          arrolado_id: a.arrolado_id,
          metodo: 'FISICA',
          manifesto_sha256: e.aceite_sha256!,
          evidencias: {
            data_fisica: a.data,
            evidencia: a.evidencia,
            via_sha256: v.via_sha256,
            scan_sha256: arquivo.sha256,
          },
        })),
      });
      await tx.expedicao_documento.update({ where: { id: e.id }, data: { estado: 'PENDENTE' } });
      return { id };
    });
  }

  repetir(ator: AtorSecretaria, id: string, dados: unknown) {
    const v = validar(dto.processoSchema, dados);
    return this.base.comando(ator, 'REPETIR_EXPEDICAO_DOCUMENTO', id, v, async (tx) => {
      const { e } = await this.comandar(tx, ator, id, v);
      if (!atualAprovada(e) || e.estado !== 'FALHOU')
        throw new ConflictException('Não há falha de expedição para retomar.');
      await tx.expedicao_documento.update({
        where: { id: e.id },
        data: { estado: 'PENDENTE', tentativas: 0, executar_apos: new Date() },
      });
      return { id };
    });
  }

  async baixar(ator: AtorSecretaria, id: string, versaoId: string, tipo: 'via' | 'final' | 'scan' | 'manifesto') {
    const e = await this.base.prisma.$transaction((tx) => this.expedicaoDoDocumento(tx, ator, id, versaoId), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    if (tipo === 'manifesto' && e.manifesto_final && e.arquivo_final) {
      await this.arquivos.storage.readAuthorized(ator, e.arquivo_final, 'anexo_documento_consulta');
      if (hashAto(e.manifesto_final as Prisma.JsonObject) !== e.final_sha256) throw new Error('Manifesto inválido.');
      return {
        bytes: Buffer.from(JSON.stringify({ sha256: e.final_sha256, manifesto: e.manifesto_final }, null, 2)),
        nome: 'manifesto-expedicao.json',
      };
    }
    const file = { via: e.via, final: e.arquivo_final, scan: e.conferencia?.arquivo, manifesto: null }[tipo];
    if (!file) throw new NotFoundException('Artefato indisponível.');
    const nome = {
      via: e.modalidade === 'FISICA' ? 'via-coleta-pendente.pdf' : 'derivacao-coleta-pendente.pdf',
      final: 'documento-expedido.pdf',
      scan: 'digitalizacao-original.pdf',
    }[tipo as 'via' | 'final' | 'scan'];
    return { bytes: await this.arquivos.storage.readAuthorized(ator, file, 'anexo_documento_consulta'), nome };
  }

  private async abrirConvite(tx: Tx, token: string, cookie?: string) {
    const c = await tx.convite_assinatura.findUnique({
      where: { hash: sha256(token) },
      include: { arrolado: true, assinatura: true, expedicao: { include: incluirExpedicao } },
    });
    if (!c || c.revogado_em || c.expira_em <= new Date()) throw conviteInvalido();
    const e = c.expedicao;
    if (
      !c.arrolado.assina ||
      e.modalidade !== 'ELETRONICA' ||
      !e.matriz ||
      !e.aceite_sha256 ||
      (!c.consumido_em && !c.recusado_em && (!atualAprovada(e) || e.estado !== 'AGUARDANDO'))
    )
      throw conviteInvalido();

    const conta = await this.identidadeCanal(tx, c.igreja_id, c.arrolado.pessoa_id, c.email).catch(() => {
      throw conviteInvalido();
    });
    if ((conta?.id ?? null) !== c.usuario_id || (conta?.auth_version ?? null) !== c.auth_version)
      throw conviteInvalido();
    if (!conta) return { c, e, sessaoId: null };
    if (!cookie) throw new UnauthorizedException('Entre com a conta vinculada a este convite.');
    const sessao = await this.sessions.verify(cookie, false);
    if (
      sessao.igreja_id !== c.igreja_id ||
      sessao.id !== c.usuario_id ||
      sessao.auth_version !== c.auth_version ||
      sessao.mfa_enrollment_required
    )
      throw conviteInvalido();
    await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${conta.id} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM sessoes WHERE id = ${sessao.sessao_id} FOR SHARE`;
    const live = await tx.sessoes.findFirst({
      where: {
        id: sessao.sessao_id,
        usuario_id: conta.id,
        auth_version: conta.auth_version,
        expira_em: { gt: new Date() },
        revogada_em: null,
        OR: [{ mfa_metodo: null }, { mfa_metodo: { not: 'recovery' } }, { mfa_confirmada_em: { not: null } }],
      },
    });
    if (!live) throw new UnauthorizedException('Conclua a autenticação da conta vinculada.');
    return { c, e, sessaoId: live.id };
  }

  consultarConvite(dados: unknown, cookie?: string) {
    const { token } = validar(dto.consultaConviteSchema, dados);
    return transacaoSerializavel(this.base.prisma, async (tx) => {
      const { c, e } = await this.abrirConvite(tx, token, cookie);
      const documento = e.versao.fonte_congelada as { numero: string };
      return {
        nome: nomeSignatario(c.arrolado),
        numero: documento.numero,
        versao: e.versao.numero,
        versao_id: e.versao_id,
        assunto: e.versao.assunto,
        manifesto_sha256: e.aceite_sha256,
        matriz_sha256: e.matriz!.sha256,
        anexos: e.versao.anexos.map((a) => ({ id: a.arquivo_id, nome: a.nome, sha256: a.arquivo.sha256 })),
        estado: c.assinatura ? 'ASSINADO' : c.recusado_em ? 'RECUSADO' : 'PENDENTE',
        assinatura_em: c.assinatura?.registrada_em ?? null,
        fuso_iana: e.fuso_iana,
        consentimento: dto.consentimento,
        codigo: e.estado === 'CONCLUIDA' ? e.codigo_verificacao : null,
      };
    });
  }

  private conferirEscopo(e: Expedicao, v: { versao_id: string; manifesto_sha256: string }) {
    if (v.versao_id !== e.versao_id || v.manifesto_sha256 !== e.aceite_sha256) throw conviteInvalido();
  }

  arquivoConvite(dados: unknown, cookie?: string) {
    const v = validar(dto.arquivoConviteSchema, dados);
    return transacaoSerializavel(this.base.prisma, async (tx) => {
      const { c, e } = await this.abrirConvite(tx, v.token, cookie);
      this.conferirEscopo(e, v);
      if (c.consumido_em || c.recusado_em) throw conviteInvalido();
      if (v.arquivo_id) {
        const a = e.versao.anexos.find((a) => a.arquivo_id === v.arquivo_id);
        if (!a) throw conviteInvalido();
        return { bytes: await this.arquivos.storage.readVerified(a.arquivo), nome: 'anexo.bin' };
      }
      const bytes = await this.arquivos.verificarAceite(e);
      if (!c.matriz_consultada_em)
        await tx.convite_assinatura.update({
          where: { id: c.id },
          data: { matriz_consultada_em: new Date() },
        });
      return { bytes, nome: 'matriz-aprovada.pdf' };
    });
  }

  decidir(dados: unknown, cookie?: string) {
    const v = validar(dto.decisaoSchema, dados);
    return transacaoSerializavel(this.base.prisma, async (tx) => {
      const { c, e, sessaoId } = await this.abrirConvite(tx, v.token, cookie);
      this.conferirEscopo(e, v);
      if (c.consumido_em || c.recusado_em) throw conviteInvalido();
      this.exigirColeta(e, 'ELETRONICA');
      const agora = new Date();
      if (v.decisao === 'RECUSAR') {
        await tx.convite_assinatura.update({
          where: { id: c.id },
          data: { recusado_em: agora, motivo_recusa: v.motivo },
        });
        return { estado: 'RECUSADO' };
      }
      if (!c.matriz_consultada_em) throw new ConflictException('Abra a matriz aprovada antes de assinar.');
      await this.arquivos.verificarAceite(e);
      await tx.convite_assinatura.update({ where: { id: c.id }, data: { consumido_em: agora } });
      await tx.assinatura_documento.create({
        data: {
          igreja_id: c.igreja_id,
          contexto_id: c.contexto_id,
          versao_id: c.versao_id,
          arrolado_id: c.arrolado_id,
          convite_id: c.id,
          metodo: 'ELETRONICA',
          manifesto_sha256: e.aceite_sha256!,
          registrada_em: agora,
          evidencias: json({
            canal: 'EMAIL_INDIVIDUAL',
            email: c.email,
            usuario_id: c.usuario_id,
            sessao_id: sessaoId,
            consulta_matriz_em: c.matriz_consultada_em,
            consentimento: dto.consentimento,
            matriz_sha256: e.matriz!.sha256,
          }),
        },
      });
      const obrigatorios = e.versao.arrolados.filter((a) => a.obrigatorio);
      const assinados = new Set([...e.assinaturas.map((a) => a.arrolado_id), c.arrolado_id]);
      const completos = obrigatorios.length > 0 && obrigatorios.every((a) => assinados.has(a.id));
      // Todas as assinaturas tocam a mesma linha para serializar o cálculo do último obrigatório.
      await tx.expedicao_documento.update({
        where: { id: e.id },
        data: { estado: completos ? 'PENDENTE' : 'AGUARDANDO', executar_apos: agora },
      });
      if (completos) await revogarConvites(tx, e.versao_id);
      return { estado: 'ASSINADO' };
    });
  }
}
