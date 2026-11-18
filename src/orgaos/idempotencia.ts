import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomInt } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import { PrismaService } from '../prisma/prisma.service';

type Chave = { igreja: string; usuario: string; orgao?: string; idempotencia: string; tipo: string; hash: string };

/** Apenas objetos normalizados pelo Zod, sem datas ou propriedades indefinidas. */
export function hashAto(dados: Record<string, unknown>): string {
  const ordenar = (v: unknown): unknown => Array.isArray(v) ? v.map(ordenar) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, ordenar(item)])) : v;
  return createHash('sha256').update(JSON.stringify(ordenar(dados))).digest('hex');
}

export async function bloquearChave(tx: Prisma.TransactionClient, igreja: string, idempotencia: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':ato-orgao:' + idempotencia}, 0))`;
}

/** A autorização atual deve ser conferida antes desta consulta. */
export async function atoAnterior(tx: Prisma.TransactionClient, c: Chave, campoOcupacao: 'ocupacao_id' | 'nova_id' | 'membro_id' | 'orgao_id' | 'politica_id' | 'cargo_id') {
  await bloquearChave(tx, c.igreja, c.idempotencia);
  if (await tx.decisao_revisao_orgao.findUnique({ where: { igreja_id_idempotencia: { igreja_id: c.igreja, idempotencia: c.idempotencia } }, select: { id: true } })) throw new ConflictException('Chave de repetição já utilizada para outro ato.');
  if (await tx.requisicao_institucional.findUnique({ where: { igreja_id_idempotencia: { igreja_id: c.igreja, idempotencia: c.idempotencia } }, select: { idempotencia: true } })) throw new ConflictException('Chave de repetição já utilizada para outro ato.');
  const anterior = await tx.ato_orgao.findUnique({ where: { igreja_id_idempotencia: { igreja_id: c.igreja, idempotencia: c.idempotencia } } });
  if (!anterior) return null;
  if (anterior.operador_id !== c.usuario || (c.orgao !== undefined && anterior.orgao_id !== c.orgao) || anterior.tipo !== c.tipo || anterior.hash_requisicao !== c.hash) throw new ConflictException('Chave de repetição já utilizada para outro ato.');
  const detalhes = anterior.detalhes;
  if (!detalhes || Array.isArray(detalhes) || typeof detalhes !== 'object' || !(campoOcupacao in detalhes)) throw new ConflictException('Resultado anterior indisponível para conferência.');
  const ocupacao = detalhes[campoOcupacao];
  if (ocupacao !== null && typeof ocupacao !== 'string') throw new ConflictException('Resultado anterior indisponível para conferência.');
  if (campoOcupacao === 'orgao_id' && ocupacao !== anterior.orgao_id) throw new ConflictException('Resultado anterior indisponível para conferência.');
  return { ato_id: anterior.id, ocupacao_id: ocupacao };
}

export async function requisicaoAnterior(tx: Prisma.TransactionClient, c: Omit<Chave, 'orgao'>) {
  await bloquearChave(tx, c.igreja, c.idempotencia);
  if (await tx.decisao_revisao_orgao.findUnique({ where: { igreja_id_idempotencia: { igreja_id: c.igreja, idempotencia: c.idempotencia } }, select: { id: true } })) throw new ConflictException('Chave de repetição já utilizada para outro ato.');
  if (await tx.ato_orgao.findUnique({ where: { igreja_id_idempotencia: { igreja_id: c.igreja, idempotencia: c.idempotencia } }, select: { id: true } })) throw new ConflictException('Chave de repetição já utilizada para outro ato.');
  const anterior = await tx.requisicao_institucional.findUnique({ where: { igreja_id_idempotencia: { igreja_id: c.igreja, idempotencia: c.idempotencia } } });
  if (!anterior) return null;
  if (anterior.usuario_id !== c.usuario || anterior.tipo !== c.tipo || anterior.hash_requisicao !== c.hash) throw new ConflictException('Chave de repetição já utilizada para outro ato.');
  const resultado = anterior.resultado;
  if (!resultado || Array.isArray(resultado) || typeof resultado !== 'object' || typeof resultado.id !== 'string') throw new ConflictException('Resultado anterior indisponível para conferência.');
  return resultado;
}

export async function registrarRequisicao(tx: Prisma.TransactionClient, c: Omit<Chave, 'orgao'>, resultado: Prisma.InputJsonObject) {
  if (typeof resultado.id !== 'string') throw new ConflictException('Resultado institucional inválido.');
  const competencia = ['COMPETENCIA_UNIDADES', 'ENCERRAMENTO_COMPETENCIA_UNIDADES'].includes(c.tipo);
  const presidencia = ['PRESIDENCIA_CONSELHO', 'ENCERRAMENTO_PRESIDENCIA'].includes(c.tipo);
  const fuso = c.tipo === 'FUSO_IGREJA';
  if (!competencia && !presidencia && !fuso) throw new ConflictException('Tipo de requisição institucional inválido.');
  if (fuso && resultado.id !== c.igreja) throw new ConflictException('Resultado institucional inválido.');
  await tx.requisicao_institucional.create({ data: { igreja_id: c.igreja, usuario_id: c.usuario, idempotencia: c.idempotencia, tipo: c.tipo, hash_requisicao: c.hash, resultado, competencia_id: competencia ? resultado.id : null, presidencia_id: presidencia ? resultado.id : null, fuso_igreja_id: fuso ? c.igreja : null } });
}

export function conflitoDeTransacao(erro: unknown) {
  return erro instanceof Prisma.PrismaClientKnownRequestError &&
    (erro.code === 'P2034' || (erro.code === 'P2010' && ['40001', '40P01'].includes(String(erro.meta?.code))));
}

/** Conflitos de transação desfazem toda a operação; refazê-la é seguro. */
export async function transacaoComRetentativa<T>(prisma: PrismaService, executar: (tx: Prisma.TransactionClient) => Promise<T>, isolamento: Prisma.TransactionIsolationLevel, conflitoRepetivel?: (erro: unknown) => boolean, maxTentativas = 3): Promise<T> {
  for (let tentativa = 0; ; tentativa++) {
    try { return await prisma.$transaction(executar, { isolationLevel: isolamento }); }
    catch (erro) {
      if ((!conflitoDeTransacao(erro) && !conflitoRepetivel?.(erro)) || tentativa + 1 >= maxTentativas) throw erro;
      await esperar(randomInt(10, Math.min(250, 30 * 2 ** tentativa) + 1));
    }
  }
}

export function transacaoSerializavel<T>(prisma: PrismaService, executar: (tx: Prisma.TransactionClient) => Promise<T>, maxTentativas = 3): Promise<T> {
  return transacaoComRetentativa(prisma, executar, Prisma.TransactionIsolationLevel.Serializable, undefined, maxTentativas);
}
