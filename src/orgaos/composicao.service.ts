import { agruparPorPessoa } from '../pessoas/agrupar-por-pessoa';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { avaliarExercicio } from '../oficiais/exercicio';
import { comporOrgao, OficialApurado } from './composicao';

/** Consulta interna em snapshot: não implica autorização para atos. */
@Injectable()
export class ComposicaoService {
  constructor(private readonly prisma: PrismaService) {}

  async consultar(igrejaId: string, tipo: 'CONSELHO' | 'JUNTA', dia: string) {
    return this.prisma.$transaction(tx => this.consultarNaTransacao(tx, igrejaId, tipo, dia), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async consultarNaTransacao(tx: Prisma.TransactionClient, igrejaId: string, tipo: 'CONSELHO' | 'JUNTA', dia: string, pessoasIds?: string[], orgaoId?: string) {
    const data = new Date(`${dia}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== dia) throw new BadRequestException('Data inválida.');
    const oficiais = await tx.oficial.findMany({
      where: {
        igreja_id: igrejaId,
        pessoa_id: pessoasIds ? { in: pessoasIds } : undefined,
        tipo: { in: tipo === 'CONSELHO' ? ['PRESBITERO_REGENTE', 'PRESBITERO_DOCENTE'] : ['DIACONO'] },
      },
      include: {
        pessoa: { select: { sexo: true } },
        eventos: { where: { data_efeito: { lte: data } } },
        mandatos: {
          where: { ...(orgaoId && { AND: [{ OR: [{ orgao_id: orgaoId }, { orgao_id: null }] }] }), data_posse: { lte: data }, OR: [{ termino_efetivo: { gte: data } }, { termino_efetivo: null, termino_previsto: { gte: data } }] },
          include: { revisoes_pendentes: { where: { revisado_em: null }, select: { id: true }, take: 1 } },
        },
        vinculos_pastorais: { where: { exercicio_institucional: true, data_inicio: { lte: data }, OR: [{ data_fim: null }, { data_fim: { gte: data } }] } },
      },
    });
    const pessoas = [...new Set(oficiais.map(o => o.pessoa_id))];
    const eventosMembresia = await tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: { in: pessoas }, data_evento: { lte: data } }, select: { pessoa_id: true, data_evento: true, ordem_dia: true, rol: true } });
    const historicos = agruparPorPessoa(eventosMembresia);
    const apurados: OficialApurado[] = oficiais.map(o => {
      const revisao_pendente = o.mandatos.some(m => m.revisoes_pendentes.length > 0);
      if (o.tipo === 'PRESBITERO_DOCENTE') {
        if (o.vinculos_pastorais.length > 1) return { pessoa_id: o.pessoa_id, sexo: o.pessoa.sexo, tipo: o.tipo, situacao: 'INDETERMINADA', revisao_pendente };
        const v = o.vinculos_pastorais[0];
        const emExercicio = v && avaliarExercicio({ data_posse: v.data_inicio, termino_previsto: data, termino_efetivo: v.data_fim }, o.eventos, data).em_exercicio;
        return { pessoa_id: o.pessoa_id, sexo: o.pessoa.sexo, tipo: o.tipo, situacao: emExercicio ? 'EM_EXERCICIO' : 'FORA_DE_EXERCICIO', revisao_pendente };
      }
      if (!o.mandatos.length) return { pessoa_id: o.pessoa_id, sexo: o.pessoa.sexo, tipo: o.tipo, situacao: 'FORA_DE_EXERCICIO', revisao_pendente };
      const rol = eventoVigente(historicos.get(o.pessoa_id) ?? [], data);
      if (o.mandatos.length > 1 || rol.situacao !== 'DEFINIDO') return { pessoa_id: o.pessoa_id, sexo: o.pessoa.sexo, tipo: o.tipo, situacao: 'INDETERMINADA', revisao_pendente };
      const emExercicio = rol.evento.rol === 'COMUNGANTES' && avaliarExercicio(o.mandatos[0], o.eventos, data).em_exercicio;
      return { pessoa_id: o.pessoa_id, sexo: o.pessoa.sexo, tipo: o.tipo, situacao: emExercicio ? 'EM_EXERCICIO' : 'FORA_DE_EXERCICIO', revisao_pendente };
    });
    return { data_referencia: dia, ...comporOrgao(tipo, apurados) };
  }
}
