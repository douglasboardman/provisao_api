import { exigirServicoDoUsuario } from '../autorizacao/operacao-atual';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { atoAnterior, bloquearChave, hashAto, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const entrada = z.object({ funcao: z.enum(['SECRETARIO', 'TESOUREIRO', 'OUTRO']).optional(), codigo: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/), nome: z.string().trim().min(1).max(120), permite_acumulacao: z.boolean(), fonte: z.string().trim().min(1).max(255), versao: z.string().trim().min(1).max(100), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();

/** Cargos adicionais dependem de norma e ato declarados; não inferidos do acesso. */
@Injectable()
export class ConfiguracaoCargosService {
  constructor(private readonly prisma: PrismaService) {}

  async criar(igrejaId: string, usuarioId: string, orgaoId: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Configuração de cargo inválida.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase(), hash = hashAto({ operacao: 'CONFIGURACAO_CARGO', orgaoId, dados: v });
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const operador = await exigirServicoDoUsuario(tx, igrejaId, usuarioId, 'ORGAOS_CONFIGURAR');
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const hoje = new Date(`${await hojeDaIgreja(tx, igrejaId)}T00:00:00Z`);
      await bloquearChave(tx, igrejaId, idempotencia);
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, gestao_presidencial: false, tipo: { in: ['CONSELHO', 'JUNTA', 'UNIDADE_MINISTERIAL'] }, ativo: true }, select: { tipo: true } });
      if (!orgao) throw new NotFoundException('Órgão não encontrado nesta igreja.');
      if (orgao.tipo === 'UNIDADE_MINISTERIAL') {
        if (operador.perfil !== 'COMUM' || !operador.pessoa_id || !await tx.competencia_unidades.findFirst({ where: { igreja_id: igrejaId, usuario_id: usuarioId, pessoa_id: operador.pessoa_id, inicio: { lte: hoje }, OR: [{ fim: null }, { fim: { gt: hoje } }] }, select: { id: true } })) throw new ForbiddenException('Competência institucional não comprovada.');
      }
      const repetido = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'CONFIGURACAO_CARGO', hash }, 'cargo_id');
      if (repetido) {
        if (!repetido.ocupacao_id) throw new BadRequestException('Resultado anterior indisponível.');
        return { id: repetido.ocupacao_id };
      }
      if (orgao.tipo === 'CONSELHO' && v.codigo === 'PRESIDENTE') throw new BadRequestException('Presidência do Conselho é institucional.');
      const cargo = await tx.cargo_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, codigo: v.codigo, nome: v.nome, funcao: v.funcao ?? 'OUTRO', permite_acumulacao: v.permite_acumulacao } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'CONFIGURACAO_CARGO', data_efeito: hoje, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { cargo_id: cargo.id, funcao: v.funcao ?? 'OUTRO', fonte: v.fonte, versao: v.versao, permite_acumulacao: v.permite_acumulacao } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, cargo_id: cargo.id } } });
      return { id: cargo.id };
    });
  }

  async definirAcumulacao(igrejaId: string, usuarioId: string, orgaoId: string, cargoId: string, dados: { permite_acumulacao: boolean; fonte: string; versao: string; autoridade: string; evidencia: string; idempotencia: string }) {
    const schema = entrada.pick({ permite_acumulacao: true, fonte: true, versao: true, autoridade: true, evidencia: true, idempotencia: true });
    const parsed = schema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Configuração de acumulação inválida.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase(), hash = hashAto({ operacao: 'CONFIGURACAO_ACUMULACAO', orgaoId, cargoId, dados: v });
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const operador = await exigirServicoDoUsuario(tx, igrejaId, usuarioId, 'ORGAOS_CONFIGURAR');
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const hoje = new Date(`${await hojeDaIgreja(tx, igrejaId)}T00:00:00Z`);
      await bloquearChave(tx, igrejaId, idempotencia);
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, gestao_presidencial: false, tipo: { in: ['CONSELHO', 'JUNTA', 'UNIDADE_MINISTERIAL'] }, ativo: true }, select: { tipo: true } });
      if (!orgao) throw new NotFoundException('Órgão não encontrado nesta igreja.');
      if (orgao.tipo === 'UNIDADE_MINISTERIAL') {
        if (operador.perfil !== 'COMUM' || !operador.pessoa_id || !await tx.competencia_unidades.findFirst({ where: { igreja_id: igrejaId, usuario_id: usuarioId, pessoa_id: operador.pessoa_id, inicio: { lte: hoje }, OR: [{ fim: null }, { fim: { gt: hoje } }] }, select: { id: true } })) throw new ForbiddenException('Competência institucional não comprovada.');
      }
      const repetido = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'CONFIGURACAO_ACUMULACAO', hash }, 'cargo_id');
      if (repetido) {
        if (repetido.ocupacao_id !== cargoId) throw new BadRequestException('Resultado anterior indisponível.');
        return { id: cargoId, permite_acumulacao: v.permite_acumulacao };
      }
      const cargo = await tx.cargo_orgao.findFirst({ where: { id: cargoId, igreja_id: igrejaId, orgao_id: orgaoId, ativo: true } });
      if (!cargo) throw new NotFoundException('Cargo não encontrado.');
      const versaoExistente = await tx.ato_orgao.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, tipo: { in: ['CONFIGURACAO_CARGO', 'CONFIGURACAO_ACUMULACAO'] }, AND: [{ detalhes: { path: ['cargo_id'], equals: cargoId } }, { detalhes: { path: ['fonte'], equals: v.fonte } }, { detalhes: { path: ['versao'], equals: v.versao } }] }, select: { id: true } });
      if (versaoExistente) throw new BadRequestException('A alteração exige versionamento normativo: informe uma nova versão da norma.');
      if (!v.permite_acumulacao) {
        const atuais = await tx.ocupacao_cargo.findMany({ where: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId, inicio: { lte: hoje }, AND: [{ OR: [{ fim: null }, { fim: { gt: hoje } }] }, { OR: [{ termino_previsto: null }, { termino_previsto: { gte: hoje } }] }] }, select: { pessoa_id: true } });
        if (atuais.length && await tx.ocupacao_cargo.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: { not: cargoId }, pessoa_id: { in: atuais.map(o => o.pessoa_id) }, inicio: { lte: hoje }, AND: [{ OR: [{ fim: null }, { fim: { gt: hoje } }] }, { OR: [{ termino_previsto: null }, { termino_previsto: { gte: hoje } }] }] }, select: { id: true } })) throw new BadRequestException('Resolva as acumulações vigentes antes de restringir a norma.');
      }
      await tx.cargo_orgao.update({ where: { id: cargo.id }, data: { permite_acumulacao: v.permite_acumulacao } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'CONFIGURACAO_ACUMULACAO', data_efeito: hoje, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { cargo_id: cargo.id, fonte: v.fonte, versao: v.versao, anterior: cargo.permite_acumulacao, permite_acumulacao: v.permite_acumulacao } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, cargo_id: cargo.id } } });
      return { id: cargo.id, permite_acumulacao: v.permite_acumulacao };
    });
  }
}
