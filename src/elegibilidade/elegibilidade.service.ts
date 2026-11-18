import { Injectable, NotFoundException } from '@nestjs/common';
import { membresia_rol } from '@prisma/client';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { PrismaService } from '../prisma/prisma.service';

/** Resultado conservador: ausência de evidência não equivale a elegibilidade. */
export type SituacaoElegibilidade = 'ELEGIVEL' | 'INELEGIVEL' | 'INDETERMINADA';
export type FinalidadeElegibilidade = 'PARTICIPACAO_UNIDADE' | 'LIDERANCA_UNIDADE' | 'ELEICAO_OFICIAL';

@Injectable()
export class ElegibilidadeService {
  constructor(private readonly prisma: PrismaService) {}

  async avaliar(igrejaId: string, pessoaId: string, data: Date, finalidade: FinalidadeElegibilidade) {
    if (Number.isNaN(data.getTime()) || data.getUTCHours() !== 0 || data.getUTCMinutes() !== 0 || data.getUTCSeconds() !== 0 || data.getUTCMilliseconds() !== 0) {
      throw new TypeError('A data de referência deve ser uma data civil UTC válida.');
    }
    const pessoa = await this.prisma.pessoas.findFirst({ where: { id: pessoaId, igreja_id: igrejaId }, select: { id: true } });
    if (!pessoa) throw new NotFoundException('Pessoa não encontrada nesta igreja.');

    const eventos = await this.prisma.eventos_membresia.findMany({
      where: { igreja_id: igrejaId, pessoa_id: pessoaId, data_evento: { lte: data } },
      select: { data_evento: true, ordem_dia: true, rol: true },
      orderBy: { data_evento: 'desc' },
    });
    const resultado = (situacao: SituacaoElegibilidade, motivo: string, rol: membresia_rol | null = null) => ({
      pessoa_id: pessoaId, igreja_id: igrejaId, data_referencia: data.toISOString().slice(0, 10), finalidade, situacao, motivo, rol,
    });
    const vigente = eventoVigente(eventos, data);
    if (vigente.situacao === 'SEM_EVENTO') return resultado('INDETERMINADA', 'Não há histórico de membresia na data informada.');
    if (vigente.situacao === 'AMBIGUO') return resultado('INDETERMINADA', 'Há eventos na mesma data sem ordem institucional completa.');
    const rol = vigente.evento.rol;
    if (rol === membresia_rol.ROL_SEPARADO || rol === membresia_rol.EXCLUIDOS) {
      return resultado('INELEGIVEL', 'A pessoa está em rol separado ou excluída na data informada.', rol);
    }
    if (finalidade !== 'PARTICIPACAO_UNIDADE' && rol !== membresia_rol.COMUNGANTES) {
      return resultado('INELEGIVEL', 'A finalidade exige pessoa comungante na data informada.', rol);
    }
    if (finalidade === 'ELEICAO_OFICIAL') {
      return resultado('INDETERMINADA', 'A eleição exige conferência de recepção, prazo, capacidade e eventuais exceções documentadas.', rol);
    }
    return resultado('ELEGIVEL', 'O rol na data informada atende ao requisito de membresia desta finalidade.', rol);
  }
}
