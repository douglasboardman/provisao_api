/** Regras civis internas da E03. Não conferem autoridade nem substituem validação no banco. */
export type TipoOrgao = 'CONSELHO' | 'JUNTA' | 'UNIDADE';
export type Intervalo = { inicio: string; fim: string | null };

function dataCivil(valor: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new Error('Data civil inválida.');
  const data = new Date(`${valor}T00:00:00.000Z`);
  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== valor) throw new Error('Data civil inválida.');
  return data;
}

function aniversario(data: Date, anos: number): Date {
  const ano = data.getUTCFullYear() + anos;
  const mes = data.getUTCMonth();
  const dia = Math.min(data.getUTCDate(), new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate());
  return new Date(Date.UTC(ano, mes, dia));
}

/** Limite exclusivo por meses civis; se o dia não existir, usa o último dia do mês. */
export function limiteExclusivoPorMeses(inicio: string, meses: number): string {
  const de = dataCivil(inicio);
  if (!Number.isSafeInteger(meses) || meses < 1 || de.getUTCFullYear() * 12 + de.getUTCMonth() + meses >= 10000 * 12) throw new Error('Prazo fora da faixa de datas civis suportada.');
  const destino = new Date(de);
  const dia = destino.getUTCDate();
  destino.setUTCDate(1);
  destino.setUTCMonth(destino.getUTCMonth() + meses);
  const fimMes = new Date(destino);
  fimMes.setUTCMonth(fimMes.getUTCMonth() + 1);
  fimMes.setUTCDate(0);
  destino.setUTCDate(Math.min(dia, fimMes.getUTCDate()));
  return destino.toISOString().slice(0, 10);
}

/** Fim civil inclusivo; o limite é o dia anterior ao aniversário do início. */
export function validarPrazoCargo(tipo: TipoOrgao, inicio: string, fim: string): void {
  const de = dataCivil(inicio);
  const ate = dataCivil(fim);
  if (ate < de) throw new Error('O término antecede o início.');
  if (tipo !== 'UNIDADE' && ate >= aniversario(de, tipo === 'JUNTA' ? 1 : 5)) {
    throw new Error('O prazo do cargo excede o limite do órgão.');
  }
}

/** Para ocupações, fim é a primeira data sem exercício; nulo mantém a ocupação aberta. */
export function ocupacoesSobrepoem(a: Intervalo, b: Intervalo): boolean {
  const inicioA = dataCivil(a.inicio).getTime();
  const inicioB = dataCivil(b.inicio).getTime();
  const fimA = a.fim === null ? Infinity : dataCivil(a.fim).getTime();
  const fimB = b.fim === null ? Infinity : dataCivil(b.fim).getTime();
  if (fimA <= inicioA || fimB <= inicioB) throw new Error('Intervalo de ocupação inválido.');
  return inicioA < fimB && inicioB < fimA;
}

/** Substituição tem efeito na mesma data do encerramento do ocupante anterior. */
export function encerrarOcupacao(atual: Intervalo, dataEfetiva: string): Intervalo {
  const inicio = dataCivil(atual.inicio);
  const fim = dataCivil(dataEfetiva);
  if (atual.fim !== null) throw new Error('A ocupação já foi encerrada.');
  if (fim <= inicio) throw new Error('A data efetiva deve ser posterior ao início; atos no mesmo dia exigem ordenação explícita.');
  return { ...atual, fim: dataEfetiva };
}
