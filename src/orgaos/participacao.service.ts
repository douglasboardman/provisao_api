import { ordemDoAto } from './ordem-ato';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma } from '@prisma/client';
import { z } from 'zod';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { PrismaService } from '../prisma/prisma.service';
import { atoAnterior, hashAto, transacaoComRetentativa } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const entrada = z.object({ pessoa_id: z.uuid(), data_efeito: z.iso.date(), ordem_efeito: z.number().int().min(1).max(9999).optional(), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();

/** Participação explícita em unidade; composição de órgãos oficiais é derivada. */
@Injectable()
export class ParticipacaoService {
  constructor(private readonly prisma: PrismaService) {}

  async alterar(igrejaId: string, usuarioId: string, orgaoId: string, acao: 'INCLUSAO' | 'SAIDA', dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success || !['INCLUSAO', 'SAIDA'].includes(acao)) throw new BadRequestException('Dados de participação inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const tipo = `PARTICIPACAO_${acao}`, hash = hashAto({ operacao: tipo, orgaoId, dados: v });
    return transacaoComRetentativa(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const gestor = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: 'GESTOR' }, select: { id: true, pessoa_id: true } });
      if (!gestor?.pessoa_id) throw new ForbiddenException('Gestor institucional vinculado a pessoa é obrigatório.');
      const hoje = await hojeDaIgreja(tx, igrejaId), data = new Date(`${hoje}T00:00:00.000Z`);
      const competencia = await tx.competencia_unidades.findFirst({ where: { igreja_id: igrejaId, usuario_id: usuarioId, pessoa_id: gestor.pessoa_id, inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] }, select: { id: true } });
      if (!competencia) throw new ForbiddenException('Competência institucional não comprovada.');
      const repetido = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo, hash }, 'membro_id');
      if (repetido) {
        if (!repetido.ocupacao_id) throw new BadRequestException('Resultado anterior indisponível para conferência.');
        return { ato_id: repetido.ato_id, membro_id: repetido.ocupacao_id };
      }
      if (v.data_efeito !== hoje) throw new BadRequestException('Data diferente de hoje exige conferência de impacto.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, gestao_presidencial: false, tipo: 'UNIDADE_MINISTERIAL', ativo: true }, select: { id: true } });
      if (!orgao) throw new NotFoundException('Unidade não encontrada nesta igreja.');
      const ordem = await ordemDoAto(tx, igrejaId, orgaoId, data, v.ordem_efeito);
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${v.pessoa_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      if (!await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id: igrejaId }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      const anterior = await tx.membro_orgao.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, pessoa_id: v.pessoa_id, fim: null } });
      let membroId: string;
      if (acao === 'INCLUSAO') {
        if (anterior) throw new BadRequestException('Pessoa já participa da unidade.');
        const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: v.pessoa_id, data_evento: { lte: data } }, select: { data_evento: true, ordem_dia: true, rol: true } });
        const rol = eventoVigente(eventos, data);
        if (rol.situacao !== 'DEFINIDO' || !['COMUNGANTES', 'NAO_COMUNGANTES'].includes(rol.evento.rol)) throw new BadRequestException('Participação exige rol elegível comprovado.');
        membroId = (await tx.membro_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, pessoa_id: v.pessoa_id, inicio: data, inicio_ordem: ordem } })).id;
      } else {
        if (!anterior || (anterior.inicio > data || (anterior.inicio.getTime() === data.getTime() && anterior.inicio_ordem >= ordem))) throw new BadRequestException('Participação ausente ou ordenação do mesmo dia necessária.');
        // Saída não altera cargo: a dispensa deve ser registrada por autoridade competente.
        if (await tx.ocupacao_cargo.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, pessoa_id: v.pessoa_id, inicio: { lte: data }, AND: [{ OR: [{ fim: null }, { fim: { gt: data } }, { fim: data, fim_ordem: { gt: ordem } }] }, { OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }] }, select: { id: true } })) throw new BadRequestException('Encerre a ocupação do cargo antes da saída e confira a ordem dos atos.');
        await tx.membro_orgao.update({ where: { id: anterior.id }, data: { fim: data, fim_ordem: ordem } });
        membroId = anterior.id;
      }
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo, data_efeito: data, autoridade: gestor.pessoa_id, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { ordem_efeito: ordem, membro_id: membroId, competencia_id: competencia.id } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, membro_id: membroId, data_efeito: v.data_efeito } } });
      return { ato_id: ato.id, membro_id: membroId };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }
}
