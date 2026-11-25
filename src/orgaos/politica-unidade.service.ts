import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { limiteExclusivoPorMeses } from './regras-periodos';
import { atoAnterior, hashAto, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const entrada = z.object({ versao: z.string().trim().min(1).max(100), fonte: z.string().trim().min(1).max(500), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000), inicio: dia, fim: dia, prazo_maximo_meses: z.number().int().min(1).max(2147483647), idempotencia: z.uuid() }).strict().refine(v => {
  if (v.inicio > v.fim) return false;
  try { limiteExclusivoPorMeses(v.fim, v.prazo_maximo_meses); return true; } catch { return false; }
});
const data = (v: string) => new Date(`${v}T00:00:00Z`);

@Injectable()
export class PoliticaUnidadeService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(igrejaId: string, usuarioId: string, orgaoId: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Política de unidade inválida.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'POLITICA_UNIDADE', orgaoId, dados: v });
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const gestor = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: 'GESTOR' }, select: { pessoa_id: true } });
      const hoje = data(await hojeDaIgreja(tx, igrejaId));
      if (!gestor?.pessoa_id || !await tx.competencia_unidades.findFirst({ where: { igreja_id: igrejaId, usuario_id: usuarioId, pessoa_id: gestor.pessoa_id, inicio: { lte: hoje }, OR: [{ fim: null }, { fim: { gt: hoje } }] }, select: { id: true } })) throw new ForbiddenException('Competência institucional não comprovada.');
      const repetido = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, orgao: orgaoId, idempotencia, tipo: 'POLITICA_UNIDADE', hash }, 'politica_id');
      if (repetido) {
        if (!repetido.ocupacao_id) throw new BadRequestException('Resultado anterior indisponível.');
        return { id: repetido.ocupacao_id };
      }
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgaoId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const orgao = await tx.orgao_interno.findFirst({ where: { id: orgaoId, igreja_id: igrejaId, ativo: true, gestao_presidencial: false, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'ELEICAO' }, select: { id: true } });
      if (!orgao) throw new NotFoundException('Unidade eleita não encontrada nesta igreja.');
      const politica = await tx.politica_unidade.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, registrado_por: usuarioId, versao: v.versao, fonte: v.fonte, autoridade: v.autoridade, evidencia: v.evidencia, inicio: data(v.inicio), fim: data(v.fim), prazo_maximo_meses: v.prazo_maximo_meses } });
      const ato = await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgaoId, operador_id: usuarioId, tipo: 'POLITICA_UNIDADE', data_efeito: hoje, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia, hash_requisicao: hash, detalhes: { politica_id: politica.id, versao: v.versao, fonte: v.fonte, inicio: v.inicio, fim: v.fim, prazo_maximo_meses: v.prazo_maximo_meses } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'ato_orgao', registro_id: ato.id, dados_novos: { orgao_id: orgaoId, politica_id: politica.id } } });
      return { id: politica.id };
    });
  }
}
