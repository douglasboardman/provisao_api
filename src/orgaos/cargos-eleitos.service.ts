import { ordemDoAto } from './ordem-ato';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { ComposicaoService } from './composicao.service';
import { validarPrazoCargo } from './regras-periodos';
import { atoAnterior, hashAto, transacaoComRetentativa, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const entrada = z.object({ pessoa_id: z.uuid(), data_eleicao: dia, data_posse: dia, ordem_efeito: z.number().int().min(1).max(9999).optional(), termino_previsto: dia, autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();
const encerramento = z.object({ data_efeito: dia, ordem_efeito: z.number().int().min(1).max(9999).optional(), motivo: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();
const data = (valor: string) => new Date(`${valor}T00:00:00Z`);

/** Registro de ato eleitoral já praticado; não confere poder de deliberação ao operador. */
@Injectable()
export class CargosEleitosService {
  constructor(private readonly prisma: PrismaService, private readonly composicao: ComposicaoService) {}

  async registrar(igrejaId: string, usuarioId: string, orgaoId: string, cargoId: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados do cargo inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'ELEICAO_CARGO', orgaoId, cargoId, dados: v });
    return transacaoComRetentativa(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const operador = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO'] } }, select: { id: true } });
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const hoje = await hojeDaIgreja(tx, igrejaId);
      const anterior = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'ELEICAO_CARGO', hash }, 'ocupacao_id');
      if (anterior) return anterior;
      if (v.data_eleicao > v.data_posse || v.data_posse !== hoje) throw new BadRequestException('A posse deve ser hoje e não pode anteceder a eleição; outros casos exigem revisão de impacto.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, ativo: true, tipo: { in: ['CONSELHO', 'JUNTA'] } } });
      if (!orgao || orgao.tipo === 'UNIDADE_MINISTERIAL') throw new NotFoundException('Órgão oficial não encontrado.');
      const ordem = await ordemDoAto(tx, igrejaId, orgaoId, data(v.data_posse), v.ordem_efeito);
      const cargo = await tx.cargo_orgao.findFirst({ where: { id: cargoId, orgao_id: orgaoId, igreja_id: igrejaId, ativo: true } });
      if (!cargo) throw new NotFoundException('Cargo não encontrado neste órgão.');
      try { validarPrazoCargo(orgao.tipo, v.data_posse, v.termino_previsto); } catch { throw new BadRequestException('Prazo incompatível com o órgão.'); }
      await tx.$queryRaw`SELECT id FROM oficial WHERE igreja_id = ${igrejaId} AND pessoa_id = ${v.pessoa_id} ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${v.pessoa_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      if (!await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id: igrejaId }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      let oficialNaPosse = false;
      for (const referencia of new Set([v.data_eleicao, v.data_posse])) {
        const situacao = await this.composicao.consultarNaTransacao(tx, igrejaId, orgao.tipo, referencia);
        const membro = situacao.membros.find(m => m.pessoa_id === v.pessoa_id);
        if (situacao.situacao_indeterminada.includes(v.pessoa_id) || membro?.revisao_pendente) throw new BadRequestException('Situação institucional exige revisão.');
        if (referencia === v.data_posse) oficialNaPosse = !!membro;
        if (!membro) {
          // O tesoureiro do Conselho pode não ser oficial; isso não lhe confere voto.
          if (orgao.tipo !== 'CONSELHO' || (cargo.funcao !== 'TESOUREIRO' && cargo.codigo !== 'TESOUREIRO')) throw new BadRequestException('O cargo exige oficial em exercício na eleição e na posse.');
          const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: v.pessoa_id, data_evento: { lte: data(referencia) } }, select: { data_evento: true, ordem_dia: true, rol: true } });
          const rol = eventoVigente(eventos, data(referencia));
          if (rol.situacao !== 'DEFINIDO' || rol.evento.rol !== 'COMUNGANTES') throw new BadRequestException('Tesoureiro exige membresia comungante comprovada.');
        }
      }
      const outras = await tx.ocupacao_cargo.findMany({ where: { igreja_id: igrejaId, orgao_id: orgaoId, pessoa_id: v.pessoa_id, cargo_id: { not: cargoId }, inicio: { lte: data(v.termino_previsto) }, AND: [{ OR: [{ fim: null }, { fim: { gt: data(v.data_posse) } }, { fim: data(v.data_posse), fim_ordem: { gt: ordem } }] }, { OR: [{ termino_previsto: null }, { termino_previsto: { gte: data(v.data_posse) } }] }] }, include: { cargo: { select: { permite_acumulacao: true } } } });
      if (outras.length && (!cargo.permite_acumulacao || outras.some(o => !o.cargo.permite_acumulacao))) throw new BadRequestException('Acumulação não autorizada para os cargos.');
      const ocupacao = await tx.ocupacao_cargo.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId, pessoa_id: v.pessoa_id, inicio: data(v.data_posse), inicio_ordem: ordem, termino_previsto: data(v.termino_previsto) } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'ELEICAO_CARGO', data_efeito: data(v.data_posse), autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { ordem_efeito: ordem, cargo_id: cargoId, ocupacao_id: ocupacao.id, data_eleicao: v.data_eleicao, termino_previsto: v.termino_previsto, oficial_na_posse: oficialNaPosse } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, cargo_id: cargoId, ocupacao_id: ocupacao.id } } });
      return { ato_id: ato.id, ocupacao_id: ocupacao.id };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }

  async encerrar(igrejaId: string, usuarioId: string, orgaoId: string, ocupacaoId: string, dados: z.infer<typeof encerramento>) {
    const parsed = encerramento.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados de encerramento inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'ENCERRAMENTO_CARGO', orgaoId, ocupacaoId, dados: v });
    const efeito = data(v.data_efeito);
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      if (!await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO'] } }, select: { id: true } })) throw new ForbiddenException('Operador não autorizado.');
      const hoje = await hojeDaIgreja(tx, igrejaId);
      const anterior = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'ENCERRAMENTO_CARGO', hash }, 'ocupacao_id');
      if (anterior) return anterior;
      if (v.data_efeito !== hoje) throw new BadRequestException('Data diferente de hoje exige revisão de impacto.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, tipo: { in: ['CONSELHO', 'JUNTA'] } }, select: { id: true } });
      if (!orgao) throw new NotFoundException('Órgão oficial não encontrado.');
      const ordem = await ordemDoAto(tx, igrejaId, orgaoId, efeito, v.ordem_efeito);
      const ocupacao = await tx.ocupacao_cargo.findFirst({ where: { id: ocupacaoId, igreja_id: igrejaId, orgao_id: orgaoId } });
      if (!ocupacao) throw new NotFoundException('Ocupação não encontrada.');
      if (ocupacao.fim || (ocupacao.inicio > efeito || (ocupacao.inicio.getTime() === efeito.getTime() && ocupacao.inicio_ordem >= ordem)) || !ocupacao.termino_previsto || ocupacao.termino_previsto < efeito) throw new BadRequestException('Ocupação não está vigente ou exige ordenação do mesmo dia.');
      await tx.ocupacao_cargo.update({ where: { id: ocupacao.id }, data: { fim: efeito, fim_ordem: ordem } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'ENCERRAMENTO_CARGO', data_efeito: efeito, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { ordem_efeito: ordem, ocupacao_id: ocupacao.id, motivo: v.motivo } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, ocupacao_id: ocupacao.id, data_efeito: v.data_efeito } } });
      return { ato_id: ato.id, ocupacao_id: ocupacao.id };
    });
  }
}
