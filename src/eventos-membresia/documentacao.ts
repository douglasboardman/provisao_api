import { Prisma } from '@prisma/client';

export const fontesDaMovimentacao = {
  referencias_ata: {
    orderBy: { sequencia: 'desc' },
    take: 1,
    select: {
      referencia_externa: true,
      versao: {
        select: {
          legada_superada: true,
          documento: { select: { estado: true } },
          expedicao: { select: { estado: true, expedido_em: true, arquivo_final_id: true } },
        },
      },
    },
  },
  insercao_retroativa: { select: { evidencia: true } },
} satisfies Prisma.eventos_membresiaInclude;

type EventoComFontes = Prisma.eventos_membresiaGetPayload<{ include: typeof fontesDaMovimentacao }>;

export function temFundamentoDocumental(evento: EventoComFontes) {
  if (evento.referencia_documental?.trim() || evento.insercao_retroativa?.evidencia.trim()) return true;
  const vinculo = evento.referencias_ata[0];
  const externa = vinculo?.referencia_externa;
  if (externa && typeof externa === 'object' && !Array.isArray(externa) && externa.conferida === true) return true;

  const versao = vinculo?.versao;
  if (!versao || versao.legada_superada) return false;
  const { estado } = versao.documento;
  if (estado === 'ANULADO' || estado === 'CANCELADO') return false;
  return estado === 'LEGADA_CONFERIDA' || Boolean(
    versao.expedicao?.estado === 'CONCLUIDA' && versao.expedicao.expedido_em && versao.expedicao.arquivo_final_id,
  );
}

export function apresentarDocumentacao<T extends EventoComFontes>(evento: T) {
  const { referencias_ata: _atas, insercao_retroativa: _insercao, ...dados } = evento;
  return { ...dados, documentado: temFundamentoDocumental(evento) };
}
