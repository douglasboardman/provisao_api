import { oficio_tipo, pessoas_sexo } from '@prisma/client';

export type OficialApurado = {
  pessoa_id: string;
  sexo: pessoas_sexo;
  tipo: oficio_tipo;
  situacao: 'EM_EXERCICIO' | 'FORA_DE_EXERCICIO' | 'INDETERMINADA';
  revisao_pendente: boolean;
};

/** Recebe situação temporal já apurada pela E02; não cria participação persistida. */
export function comporOrgao(tipo: 'CONSELHO' | 'JUNTA', oficiais: OficialApurado[]) {
  const permitidos: oficio_tipo[] = tipo === 'CONSELHO'
    ? ['PRESBITERO_REGENTE', 'PRESBITERO_DOCENTE']
    : ['DIACONO'];
  const porPessoa = new Map<string, { pessoa_id: string; oficios: oficio_tipo[]; revisao_pendente: boolean }>();
  const pendentes = new Set<string>();
  for (const oficial of oficiais) {
    if (oficial.sexo !== 'MASCULINO' || !permitidos.includes(oficial.tipo)) continue;
    if (oficial.situacao === 'INDETERMINADA') {
      pendentes.add(oficial.pessoa_id);
      continue;
    }
    if (oficial.situacao !== 'EM_EXERCICIO') continue;
    const membro = porPessoa.get(oficial.pessoa_id) ?? { pessoa_id: oficial.pessoa_id, oficios: [], revisao_pendente: false };
    if (!membro.oficios.includes(oficial.tipo)) membro.oficios.push(oficial.tipo);
    membro.revisao_pendente ||= oficial.revisao_pendente;
    porPessoa.set(oficial.pessoa_id, membro);
  }
  return { membros: [...porPessoa.values()], situacao_indeterminada: [...pendentes] };
}
