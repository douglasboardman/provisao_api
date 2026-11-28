import { ordemDoAto } from './ordem-ato';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { avaliarExercicio } from '../oficiais/exercicio';
import { atoAnterior, bloquearChave, hashAto, transacaoComRetentativa } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const entrada = z.object({ pessoa_id: z.uuid().nullable(), data_efeito: z.iso.date(), ordem_efeito: z.number().int().min(1).max(9999), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();

/** Apenas atos no dia corrente; registros retroativos exigem futura análise de impacto. */
@Injectable()
export class DesignacoesService {
  constructor(private readonly prisma: PrismaService) {}

  async substituir(igrejaId: string, usuarioId: string, orgaoId: string, cargoId: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados da designação inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const tipo = v.pessoa_id ? 'DESIGNACAO' : 'DISPENSA';
    const hash = hashAto({ operacao: tipo, orgaoId, cargoId, dados: v });
    return transacaoComRetentativa(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const usuario = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: 'COMUM' }, select: { pessoa_id: true } });
      if (!usuario?.pessoa_id) throw new ForbiddenException('Responsável institucional vinculado a pessoa é obrigatório.');
      const hoje = await hojeDaIgreja(tx, igrejaId), data = new Date(`${hoje}T00:00:00.000Z`);
      await bloquearChave(tx, igrejaId, idempotencia);
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, ativo: true, gestao_presidencial: false, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'DESIGNACAO' } });
      if (!orgao) throw new NotFoundException('Unidade designada não encontrada nesta igreja.');
      const cargo = await tx.cargo_orgao.findFirst({ where: { id: cargoId, orgao_id: orgaoId, igreja_id: igrejaId, ativo: true } });
      if (!cargo) throw new NotFoundException('Cargo de designação não encontrado.');
      const presidencia = await tx.presidencia_conselho.findFirst({ where: { igreja_id: igrejaId, inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }], oficial: { pessoa_id: usuario.pessoa_id, tipo: 'PRESBITERO_DOCENTE', pessoa: { sexo: 'MASCULINO' } } }, select: { id: true, oficial_id: true } });
      if (!presidencia) throw new ForbiddenException('Presidência institucional não comprovada.');
      await tx.$queryRaw`SELECT id FROM oficial WHERE id = ${presidencia.oficial_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      // Encerramento da presidência usa o bloqueio do oficial; também bloquear a
      // própria linha força uma nova tentativa se ela mudou após o snapshot.
      await tx.$queryRaw`SELECT id FROM presidencia_conselho WHERE id = ${presidencia.id} AND igreja_id = ${igrejaId} FOR SHARE`;
      if (!await tx.presidencia_conselho.findFirst({ where: { id: presidencia.id, igreja_id: igrejaId, inicio: { lte: data }, OR: [{ fim: null }, { fim: { gt: data } }] }, select: { id: true } })) throw new ForbiddenException('Presidência institucional não está vigente.');
      const vinculos = await tx.vinculo_pastoral.findMany({ where: { igreja_id: igrejaId, oficial_id: presidencia.oficial_id, exercicio_institucional: true, data_inicio: { lte: data }, OR: [{ data_fim: null }, { data_fim: { gte: data } }] }, take: 2 });
      const eventos = await tx.evento_oficial.findMany({ where: { igreja_id: igrejaId, oficial_id: presidencia.oficial_id, data_efeito: { lte: data } } });
      if (vinculos.length !== 1 || !avaliarExercicio({ data_posse: vinculos[0].data_inicio, termino_previsto: data, termino_efetivo: vinculos[0].data_fim }, eventos, data).em_exercicio) throw new ForbiddenException('Presidente sem exercício pastoral comprovado.');
      const anterior = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo, hash }, 'nova_id');
      if (anterior) return anterior;
      if (v.data_efeito !== hoje) throw new BadRequestException('Data diferente de hoje exige conferência de impacto.');
      await ordemDoAto(tx, igrejaId, orgaoId, data, v.ordem_efeito);
      if (v.pessoa_id) {
        await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${v.pessoa_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
        const pessoa = await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id: igrejaId }, select: { id: true } });
        if (!pessoa) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
        const historico = await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: pessoa.id, data_evento: { lte: data } }, select: { data_evento: true, ordem_dia: true, rol: true } });
        const rol = eventoVigente(historico, data);
        if (rol.situacao !== 'DEFINIDO' || rol.evento.rol !== 'COMUNGANTES') throw new BadRequestException('Liderança exige membresia comungante comprovada.');
        const outras = await tx.ocupacao_cargo.findMany({ where: { igreja_id: igrejaId, orgao_id: orgaoId, pessoa_id: pessoa.id, cargo_id: { not: cargoId }, AND: [
          { OR: [{ inicio: { lt: data } }, { inicio: data, inicio_ordem: { lte: v.ordem_efeito } }] },
          { OR: [{ fim: null }, { fim: { gt: data } }, { fim: data, fim_ordem: { gt: v.ordem_efeito } }] },
          { OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] },
        ] }, include: { cargo: { select: { permite_acumulacao: true } } } });
        if (outras.length && (!cargo.permite_acumulacao || outras.some(o => !o.cargo.permite_acumulacao))) throw new BadRequestException('Acumulação não autorizada para os cargos.');
      }
      const posterior = await tx.ocupacao_cargo.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId, OR: [
        { inicio: { gt: data } }, { inicio: data, inicio_ordem: { gte: v.ordem_efeito } },
        { fim: { gt: data } }, { fim: data, fim_ordem: { gte: v.ordem_efeito } },
      ] }, select: { id: true } });
      if (posterior) throw new BadRequestException('Ordem já ocupada ou ato retroativo exige conferência.');
      const atual = await tx.ocupacao_cargo.findFirst({ where: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId, fim: null }, orderBy: { inicio: 'desc' } });
      if (!atual && !v.pessoa_id) throw new BadRequestException('Cargo já está vago.');
      if (atual && atual.pessoa_id === v.pessoa_id) throw new BadRequestException('A pessoa já ocupa o cargo.');
      if (atual) await tx.ocupacao_cargo.update({ where: { id: atual.id }, data: { fim: data, fim_ordem: v.ordem_efeito } });
      const nova = v.pessoa_id ? await tx.ocupacao_cargo.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId, pessoa_id: v.pessoa_id, inicio: data, inicio_ordem: v.ordem_efeito } }) : null;
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo, data_efeito: data, autoridade: usuario.pessoa_id, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { presidencia_id: presidencia.id, cargo_id: cargoId, ordem_efeito: v.ordem_efeito, anterior_id: atual?.id ?? null, nova_id: nova?.id ?? null } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, cargo_id: cargoId, data_efeito: hoje, ordem_efeito: v.ordem_efeito, anterior_id: atual?.id ?? null, nova_id: nova?.id ?? null } } });
      return { ato_id: ato.id, ocupacao_id: nova?.id ?? null };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }
}
