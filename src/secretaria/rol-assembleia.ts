import type { membresia_rol } from '@prisma/client';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { agruparPorPessoa } from '../pessoas/agrupar-por-pessoa';

export type EventoDoRol = { pessoa_id: string; nome: string; data_evento: Date; ordem_dia: number | null; rol: membresia_rol };

export function linhasDoRol(eventos: EventoDoRol[], referencia: Date) {
  const linhas: { pessoa_id: string; nome: string; categoria: 'COMUNGANTES' | 'NAO_COMUNGANTES' | 'CONFERIR' }[] = [];
  for (const [id, historico] of agruparPorPessoa(eventos)) {
    const vigente = eventoVigente(historico, referencia);
    if (vigente.situacao === 'SEM_EVENTO') continue;
    const categoria = vigente.situacao === 'AMBIGUO' ? 'CONFERIR' : vigente.evento.rol;
    if (categoria === 'COMUNGANTES' || categoria === 'NAO_COMUNGANTES' || categoria === 'CONFERIR')
      linhas.push({ pessoa_id: id, nome: historico[0].nome, categoria });
  }
  return linhas.sort((a,b) => a.nome.localeCompare(b.nome,'pt-BR') || a.pessoa_id.localeCompare(b.pessoa_id));
}
