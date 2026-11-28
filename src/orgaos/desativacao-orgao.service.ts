import { exigirServicoDoUsuario } from '../autorizacao/operacao-atual';
import { ordemDoAto } from './ordem-ato';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { atoAnterior, bloquearChave, hashAto, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const entrada = z.object({ data_efeito: z.iso.date(), ordem_efeito: z.number().int().min(1).max(9999).optional(), motivo: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();

@Injectable()
export class DesativacaoOrgaoService {
  constructor(private readonly prisma: PrismaService) {}

  async desativar(igrejaId: string, usuarioId: string, orgaoId: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados de desativação inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'DESATIVACAO', orgaoId, dados: v });
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const operador = await exigirServicoDoUsuario(tx, igrejaId, usuarioId, 'ORGAOS_CONFIGURAR');
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const hoje = await hojeDaIgreja(tx, igrejaId), efeito = new Date(`${hoje}T00:00:00Z`);
      await bloquearChave(tx, igrejaId, idempotencia);
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, gestao_presidencial: false, tipo: { in: ['CONSELHO', 'JUNTA', 'UNIDADE_MINISTERIAL'] } }, select: { tipo: true, ativo: true, data_criacao: true } });
      if (!orgao) throw new NotFoundException('Órgão não encontrado nesta igreja.');
      if (orgao.tipo === 'UNIDADE_MINISTERIAL' && (operador.perfil !== 'COMUM' || !operador.pessoa_id || !await tx.competencia_unidades.findFirst({ where: { igreja_id: igrejaId, usuario_id: usuarioId, pessoa_id: operador.pessoa_id, inicio: { lte: efeito }, OR: [{ fim: null }, { fim: { gt: efeito } }] }, select: { id: true } }))) throw new ForbiddenException('Competência institucional não comprovada.');
      const repetido = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'DESATIVACAO', hash }, 'orgao_id');
      if (repetido) {
        if (repetido.ocupacao_id !== orgaoId) throw new BadRequestException('Resultado anterior indisponível para conferência.');
        return { ato_id: repetido.ato_id, orgao_id: orgaoId };
      }
      if (v.data_efeito !== hoje) throw new BadRequestException('Data diferente de hoje exige conferência de impacto.');
      if (!orgao.ativo || (orgao.data_criacao && orgao.data_criacao > efeito)) throw new BadRequestException('Órgão já desativado ou data inválida.');
      const ordem = await ordemDoAto(tx, igrejaId, orgaoId, efeito, v.ordem_efeito);
      const ocupacao = await tx.ocupacao_cargo.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, AND: [{ OR: [{ fim: null }, { fim: { gt: efeito } }, { fim: efeito, fim_ordem: { gt: ordem } }] }, { OR: [{ termino_previsto: null }, { termino_previsto: { gte: efeito } }] }] }, select: { id: true } });
      if (ocupacao) throw new BadRequestException('Resolva as ocupações vigentes ou futuras antes de desativar o órgão.');
      const participantes = await tx.membro_orgao.findMany({ where: { igreja_id: igrejaId, orgao_id: orgaoId, fim: null }, select: { id: true, inicio: true, inicio_ordem: true } });
      if (participantes.some(p => p.inicio > efeito || (p.inicio.getTime() === efeito.getTime() && p.inicio_ordem >= ordem))) throw new BadRequestException('Participação iniciada hoje exige ordenação explícita.');
      await tx.membro_orgao.updateMany({ where: { igreja_id: igrejaId, orgao_id: orgaoId, fim: null }, data: { fim: efeito, fim_ordem: ordem } });
      await tx.orgao_interno.update({ where: { id: orgaoId }, data: { ativo: false } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'DESATIVACAO', data_efeito: efeito, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { ordem_efeito: ordem, orgao_id: orgaoId, motivo: v.motivo, participacoes_encerradas: participantes.map(p => p.id) } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'orgao_interno', registro_id: orgaoId, dados_antigos: { ativo: true }, dados_novos: { ativo: false, ato_id: ato.id, data_efeito: hoje } } });
      return { ato_id: ato.id, orgao_id: orgaoId };
    });
  }
}
