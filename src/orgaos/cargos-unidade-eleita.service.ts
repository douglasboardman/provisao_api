import { ordemDoAto } from './ordem-ato';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { limiteExclusivoPorMeses } from './regras-periodos';
import { atoAnterior, hashAto, transacaoComRetentativa, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const entrada = z.object({ pessoa_id: z.uuid(), politica_id: z.uuid(), data_eleicao: dia, data_posse: dia, ordem_efeito: z.number().int().min(1).max(9999).optional(), termino_previsto: dia, autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();
const encerramento = z.object({ data_efeito: dia, ordem_efeito: z.number().int().min(1).max(9999).optional(), motivo: z.string().trim().min(1).max(1000), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), idempotencia: z.uuid() }).strict();
const data = (v: string) => new Date(`${v}T00:00:00Z`);

/** Registro de resultado eleitoral, distinto da designação pastoral de livre escolha. */
@Injectable()
export class CargosUnidadeEleitaService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(igrejaId: string, usuarioId: string, orgaoId: string, cargoId: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados da eleição inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'ELEICAO_CARGO_UNIDADE', orgaoId, cargoId, dados: v });
    return transacaoComRetentativa(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const gestor = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: 'GESTOR' }, select: { pessoa_id: true } });
      const hoje = await hojeDaIgreja(tx, igrejaId);
      if (!gestor?.pessoa_id || !await tx.competencia_unidades.findFirst({ where: { igreja_id: igrejaId, usuario_id: usuarioId, pessoa_id: gestor.pessoa_id, inicio: { lte: data(hoje) }, OR: [{ fim: null }, { fim: { gt: data(hoje) } }] }, select: { id: true } })) throw new ForbiddenException('Competência institucional não comprovada.');
      const anterior = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'ELEICAO_CARGO_UNIDADE', hash }, 'ocupacao_id');
      if (anterior) return anterior;
      if (v.data_posse !== hoje || v.data_eleicao > v.data_posse || v.termino_previsto < v.data_posse) throw new BadRequestException('Posse deve ser hoje, após a eleição e antes do término.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, ativo: true, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'ELEICAO' }, select: { data_criacao: true } });
      if (!orgao) throw new NotFoundException('Unidade eleita não encontrada nesta igreja.');
      if (data(v.data_eleicao) < orgao.data_criacao) throw new BadRequestException('Eleição anterior à criação da unidade.');
      const ordem = await ordemDoAto(tx, igrejaId, orgaoId, data(v.data_posse), v.ordem_efeito);
      const cargo = await tx.cargo_orgao.findFirst({ where: { id: cargoId, igreja_id: igrejaId, orgao_id: orgaoId, ativo: true } });
      if (!cargo) throw new NotFoundException('Cargo não encontrado nesta unidade.');
      await tx.$queryRaw`SELECT id FROM politica_unidade WHERE id = ${v.politica_id} AND igreja_id = ${igrejaId} AND orgao_id = ${orgaoId} FOR SHARE`;
      const politica = await tx.politica_unidade.findFirst({ where: { id: v.politica_id, igreja_id: igrejaId, orgao_id: orgaoId, inicio: { lte: data(v.data_eleicao) }, fim: { gte: data(v.data_posse) } } });
      if (!politica) throw new BadRequestException('Política não cobre a eleição e a posse nesta unidade.');
      if (v.termino_previsto >= limiteExclusivoPorMeses(v.data_posse, politica.prazo_maximo_meses)) throw new BadRequestException('Prazo excede o máximo previsto na política.');
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${v.pessoa_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      if (!await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id: igrejaId }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: v.pessoa_id, data_evento: { lte: data(v.data_posse) } }, select: { data_evento: true, ordem_dia: true, rol: true } });
      for (const referencia of new Set([v.data_eleicao, v.data_posse])) {
        const rol = eventoVigente(eventos, data(referencia));
        if (rol.situacao !== 'DEFINIDO' || rol.evento.rol !== 'COMUNGANTES') throw new BadRequestException('Liderança exige membresia comungante comprovada na eleição e na posse.');
      }
      const outras = await tx.ocupacao_cargo.findMany({ where: { igreja_id: igrejaId, orgao_id: orgaoId, pessoa_id: v.pessoa_id, cargo_id: { not: cargoId }, inicio: { lte: data(v.termino_previsto) }, AND: [{ OR: [{ fim: null }, { fim: { gt: data(v.data_posse) } }, { fim: data(v.data_posse), fim_ordem: { gt: ordem } }] }, { OR: [{ termino_previsto: null }, { termino_previsto: { gte: data(v.data_posse) } }] }] }, include: { cargo: { select: { permite_acumulacao: true } } } });
      if (outras.length && (!cargo.permite_acumulacao || outras.some(o => !o.cargo.permite_acumulacao))) throw new BadRequestException('Acumulação não autorizada para os cargos.');
      const ocupacao = await tx.ocupacao_cargo.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, cargo_id: cargoId, pessoa_id: v.pessoa_id, inicio: data(v.data_posse), inicio_ordem: ordem, termino_previsto: data(v.termino_previsto), politica_unidade_id: politica.id } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'ELEICAO_CARGO_UNIDADE', data_efeito: data(v.data_posse), autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { ordem_efeito: ordem, cargo_id: cargoId, ocupacao_id: ocupacao.id, politica_id: politica.id, data_eleicao: v.data_eleicao, termino_previsto: v.termino_previsto } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, cargo_id: cargoId, ocupacao_id: ocupacao.id, politica_id: politica.id } } });
      return { ato_id: ato.id, ocupacao_id: ocupacao.id };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }

  async encerrar(igrejaId: string, usuarioId: string, orgaoId: string, ocupacaoId: string, dados: z.infer<typeof encerramento>) {
    const parsed = encerramento.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados de encerramento inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'ENCERRAMENTO_CARGO_UNIDADE', orgaoId, ocupacaoId, dados: v });
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const gestor = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: 'GESTOR' }, select: { pessoa_id: true } });
      const hoje = await hojeDaIgreja(tx, igrejaId), efeito = data(hoje);
      if (!gestor?.pessoa_id || !await tx.competencia_unidades.findFirst({ where: { igreja_id: igrejaId, usuario_id: usuarioId, pessoa_id: gestor.pessoa_id, inicio: { lte: efeito }, OR: [{ fim: null }, { fim: { gt: efeito } }] }, select: { id: true } })) throw new ForbiddenException('Competência institucional não comprovada.');
      const anterior = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'ENCERRAMENTO_CARGO_UNIDADE', hash }, 'ocupacao_id');
      if (anterior) return anterior;
      if (v.data_efeito !== hoje) throw new BadRequestException('Data diferente de hoje exige revisão de impacto.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'ELEICAO' }, select: { id: true } });
      if (!orgao) throw new NotFoundException('Unidade eleita não encontrada nesta igreja.');
      const ordem = await ordemDoAto(tx, igrejaId, orgaoId, efeito, v.ordem_efeito);
      const ocupacao = await tx.ocupacao_cargo.findFirst({ where: { id: ocupacaoId, igreja_id: igrejaId, orgao_id: orgaoId, politica_unidade_id: { not: null } } });
      if (!ocupacao) throw new NotFoundException('Ocupação eleitoral não encontrada.');
      if (ocupacao.fim || (ocupacao.inicio > efeito || (ocupacao.inicio.getTime() === efeito.getTime() && ocupacao.inicio_ordem >= ordem)) || !ocupacao.termino_previsto || ocupacao.termino_previsto < efeito) throw new BadRequestException('Ocupação não está vigente ou exige ordenação do mesmo dia.');
      await tx.ocupacao_cargo.update({ where: { id: ocupacao.id }, data: { fim: efeito, fim_ordem: ordem } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'ENCERRAMENTO_CARGO_UNIDADE', data_efeito: efeito, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { ordem_efeito: ordem, ocupacao_id: ocupacao.id, politica_id: ocupacao.politica_unidade_id, motivo: v.motivo } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, ocupacao_id: ocupacao.id, data_efeito: hoje } } });
      return { ato_id: ato.id, ocupacao_id: ocupacao.id };
    });
  }
}
