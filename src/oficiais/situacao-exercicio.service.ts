import { exigirServicoDoUsuario } from '../autorizacao/operacao-atual';
import { decidirServico } from '../autorizacao/politica';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { membresia_rol, Prisma, usuarios_perfil } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { avaliarExercicio } from './exercicio';

/** Informa exercício cadastrado; competência para um ato é uma verificação separada. */
@Injectable()
export class SituacaoExercicioService {
  constructor(private readonly prisma: PrismaService) {}
  async consultar(igrejaId: string, usuarioId: string, oficialId: string, dataReferencia: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia)) throw new BadRequestException('Data inválida.');
    const data = new Date(`${dataReferencia}T00:00:00.000Z`);
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== dataReferencia) throw new BadRequestException('Data inválida.');
    return this.prisma.$transaction(async tx => {
      await exigirServicoDoUsuario(tx, igrejaId, usuarioId, 'OFICIAIS_CONSULTAR');
      const oficial = await tx.oficial.findFirst({ where: { id: oficialId, igreja_id: igrejaId }, select: { id: true, tipo: true, pessoa_id: true } });
      if (!oficial) throw new NotFoundException('Oficial não encontrado nesta igreja.');
      const eventos = await tx.evento_oficial.findMany({ where: { igreja_id: igrejaId, oficial_id: oficialId, data_efeito: { lte: data } }, orderBy: [{ data_efeito: 'asc' }, { ordem: 'asc' }] });
      if (oficial.tipo === 'PRESBITERO_DOCENTE') {
        const vinculos = await tx.vinculo_pastoral.findMany({ where: { igreja_id: igrejaId, oficial_id: oficialId, exercicio_institucional: true, data_inicio: { lte: data }, OR: [{ data_fim: null }, { data_fim: { gte: data } }] }, select: { id: true, data_inicio: true, data_fim: true } });
        if (!vinculos.length) return { situacao: 'FORA_DE_EXERCICIO', motivo: 'SEM_VINCULO_PASTORAL', data_referencia: dataReferencia };
        const exercicio = avaliarExercicio({ data_posse: vinculos[0].data_inicio, termino_previsto: data, termino_efetivo: vinculos[0].data_fim }, eventos, data);
        return { situacao: exercicio.em_exercicio ? 'EM_EXERCICIO' : 'FORA_DE_EXERCICIO', motivo: exercicio.motivo, data_referencia: dataReferencia };
      }
      const [mandatos, membros] = await Promise.all([
        tx.mandato_oficial.findMany({ where: { igreja_id: igrejaId, oficial_id: oficialId, data_posse: { lte: data }, OR: [{ termino_efetivo: { gte: data } }, { termino_efetivo: null, termino_previsto: { gte: data } }] }, take: 2 }),
        tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: oficial.pessoa_id, data_evento: { lte: data } }, orderBy: { data_evento: 'desc' }, select: { rol: true, data_evento: true, ordem_dia: true } }),
      ]);
      if (!mandatos.length) return { situacao: 'FORA_DE_EXERCICIO', motivo: 'SEM_MANDATO_VIGENTE', data_referencia: dataReferencia };
      const revisaoPendente = !!await tx.revisao_eleitoral_item.findFirst({ where: { igreja_id: igrejaId, mandato_id: { in: mandatos.map(m => m.id) }, revisado_em: null }, select: { id: true } });
      const vigente = eventoVigente(membros, data);
      if (mandatos.length > 1 || vigente.situacao !== 'DEFINIDO') return { situacao: 'INDETERMINADA', motivo: 'HISTORICO_INCOMPLETO_OU_AMBIGUO', data_referencia: dataReferencia, revisao_pendente: revisaoPendente };
      if (vigente.evento.rol !== membresia_rol.COMUNGANTES) return { situacao: 'FORA_DE_EXERCICIO', motivo: 'MEMBRESIA_NAO_COMUNGANTE', data_referencia: dataReferencia, revisao_pendente: revisaoPendente };
      const exercicio = avaliarExercicio(mandatos[0], eventos, data);
      return { situacao: exercicio.em_exercicio ? 'EM_EXERCICIO' : 'FORA_DE_EXERCICIO', motivo: exercicio.motivo, data_referencia: dataReferencia, revisao_pendente: revisaoPendente };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
