import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, membresia_rol, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { PrismaService } from '../prisma/prisma.service';
import { avaliarEleicaoOficial } from './eleicao-oficial';
import { camposEventoRecepcao, recepcaoDaMembresia } from './recepcao-membresia';

const dataCivil = z.iso.date().refine(s => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
});
const dadosConferencia = z.object({
  pessoa_id: z.string().uuid(), politica_id: z.string().uuid(), data_eleicao: dataCivil,
  excecao_transferencia: z.object({ oficialTransferido: z.boolean(), autoridade: z.string().trim().min(1).max(255), evidencia: z.string().trim().min(1).max(1000) }).strict().optional(),
});
const conferenciaSchema = z.union([
  dadosConferencia.extend({ candidatura_aprovada_conselho: z.boolean() }).strict(),
  dadosConferencia.extend({
    data_recepcao: dataCivil, evidencia_recepcao: z.string().trim().min(1).max(1000),
    capacidade_confirmada: z.boolean(), evidencia_capacidade: z.string().trim().max(1000),
  }).strict().refine(v => !v.capacidade_confirmada || v.evidencia_capacidade.length > 0),
]);
type EntradaConferencia = z.infer<typeof conferenciaSchema>;

/** Confere requisitos e grava um retrato; não registra eleição, posse nem autoridade. */
@Injectable()
export class ConferenciaEleicaoService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(igrejaId: string, usuarioId: string, dados: EntradaConferencia) {
    const parsed = conferenciaSchema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados de conferência inválidos.');
    const entrada = parsed.data;
    const eleicao = new Date(`${entrada.data_eleicao}T00:00:00.000Z`);
    const capacidade = 'candidatura_aprovada_conselho' in entrada
      ? {
          confirmada: entrada.candidatura_aprovada_conselho,
          evidencia: entrada.candidatura_aprovada_conselho
            ? 'Aprovação da candidatura pelo Conselho declarada na conferência eleitoral.' : '',
        }
      : { confirmada: entrada.capacidade_confirmada, evidencia: entrada.evidencia_capacidade };
    return this.prisma.$transaction(async tx => {
      // O bloqueio antecede a leitura para serializar com inclusões e correções de membresia.
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${entrada.pessoa_id} AND igreja_id = ${igrejaId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM politica_eleicao_oficial WHERE id = ${entrada.politica_id} AND igreja_id = ${igrejaId} FOR SHARE`;
      const [pessoa, politica, usuario, eventos] = await Promise.all([
        tx.pessoas.findFirst({ where: { id: entrada.pessoa_id, igreja_id: igrejaId }, select: { id: true, data_nascimento: true, sexo: true } }),
        tx.politica_eleicao_oficial.findFirst({ where: { id: entrada.politica_id, igreja_id: igrejaId, vigente_desde: { lte: eleicao }, OR: [{ vigente_ate: null }, { vigente_ate: { gte: eleicao } }] } }),
        tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.SECRETARIO, usuarios_perfil.GESTOR] } }, select: { id: true } }),
        tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: entrada.pessoa_id, data_evento: { lte: eleicao } }, select: camposEventoRecepcao }),
      ]);
      if (!pessoa || !politica || !usuario) throw new NotFoundException('Pessoa, política vigente ou operador não encontrado nesta igreja.');
      const vigente = eventoVigente(eventos, eleicao);
      if (pessoa.sexo !== 'MASCULINO' || vigente.situacao !== 'DEFINIDO' || vigente.evento.rol !== membresia_rol.COMUNGANTES) {
        throw new BadRequestException('A conferência exige pessoa do sexo masculino com membresia comungante comprovada na data da eleição.');
      }
      const recepcao = recepcaoDaMembresia(eventos, eleicao);
      if (!recepcao) throw new BadRequestException('Confira no histórico de membresia o evento que iniciou o vínculo vigente na data da eleição.');
      const evidenciaRecepcao = `Histórico de membresia, evento ${recepcao.id}.`;
      let avaliacao: ReturnType<typeof avaliarEleicaoOficial>;
      try {
        avaliacao = avaliarEleicaoOficial({ dataEleicao: entrada.data_eleicao, dataRecepcao: recepcao.data_evento.toISOString().slice(0, 10),
          evidenciaRecepcao, dataNascimento: pessoa.data_nascimento.toISOString().slice(0, 10),
          capacidadeConfirmada: capacidade.confirmada, evidenciaCapacidade: capacidade.evidencia,
          excecaoTransferencia: entrada.excecao_transferencia },
        { idadeMinima: politica.idade_minima, fonte: politica.fonte, versao: politica.versao,
          vigenteDesde: politica.vigente_desde.toISOString().slice(0, 10), aniversarioBissexto: politica.aniversario_bissexto === 'DIA_28_FEVEREIRO' ? '28_FEVEREIRO' : '01_MARCO' });
      } catch { throw new BadRequestException('Datas ou política incompatíveis com a eleição.'); }
      const resultado = { ...avaliacao, rol: vigente.evento.rol, evento_membresia_id: vigente.evento.id,
        evento_recepcao_id: recepcao.id,
        situacao: avaliacao.requisitosAtendidos ? 'REQUISITOS_CONFERIDOS' : 'REQUISITOS_NAO_ATENDIDOS',
        observacao: 'Conferência preliminar; não constitui registro de eleição nem validação de posse.' };
      const registro = await tx.conferencia_eleicao_oficial.create({ data: {
        igreja_id: igrejaId, pessoa_id: pessoa.id, politica_id: politica.id, data_eleicao: eleicao, data_recepcao: recepcao.data_evento,
        evidencia_recepcao: evidenciaRecepcao, capacidade_confirmada: capacidade.confirmada,
        evidencia_capacidade: capacidade.evidencia, excecao_transferencia: entrada.excecao_transferencia ?? Prisma.DbNull,
        resultado, criado_por_id: usuarioId,
      } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId,
        acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'conferencia_eleicao_oficial', registro_id: registro.id,
        dados_novos: { pessoa_id: pessoa.id, politica_id: politica.id, data_eleicao: entrada.data_eleicao, situacao: resultado.situacao } } });
      return registro;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
