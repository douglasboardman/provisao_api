import { z } from 'zod';
import { limiteExclusivoPorMeses } from './regras-periodos';

export const siglaSociedade = z.enum(['UCP', 'UPA', 'UMP', 'SAF', 'UPH']);
type Sigla = z.infer<typeof siglaSociedade>;
export const sociedadeJuvenil = (tipo: string | null | undefined) => tipo === 'UCP' || tipo === 'UPA';
export const dataCivilOrgao = (dia: string) => new Date(dia + 'T00:00:00.000Z');
export const diaCivilOrgao = (data: Date) => data.toISOString().slice(0, 10);
export const faixaCivil = (nascimento: Date, idade: number) => limiteExclusivoPorMeses(diaCivilOrgao(nascimento), idade * 12);

export const regrasSociedade = z.object({
  idade_minima: z.number().int().min(6).max(80),
  idade_maxima: z.number().int().min(6).max(99).nullable(),
  sexo: z.enum(['FEMININO', 'MASCULINO']).nullable(),
  escola_dominical: z.boolean(),
  diretoria_reduzida: z.boolean(),
  meses_filiacao_diretoria: z.number().int().min(0).max(12),
  segundo_secretario_ucp: z.boolean(),
});
export type RegrasSociedade = z.infer<typeof regrasSociedade>;

export function regraPadrao(sigla: Sigla): RegrasSociedade {
  const idades: Record<Sigla, [number, number | null]> = { UCP: [6, 11], UPA: [12, 18], UMP: [19, 35], SAF: [18, null], UPH: [18, null] };
  const [idade_minima, idade_maxima] = idades[sigla];
  return { idade_minima, idade_maxima, sexo: sigla === 'SAF' ? 'FEMININO' : sigla === 'UPH' ? 'MASCULINO' : null,
    escola_dominical: false, diretoria_reduzida: false, meses_filiacao_diretoria: ['UPA', 'SAF', 'UPH'].includes(sigla) ? 6 : 0,
    segundo_secretario_ucp: false };
}

export function cabeNaFaixa(regra: RegrasSociedade, nascimento: Date, dia: string) {
  return faixaCivil(nascimento, regra.idade_minima) <= dia &&
    (regra.idade_maxima === null || dia < faixaCivil(nascimento, regra.idade_maxima + 1));
}

export function cargosSociedade(sigla: Sigla, regra: RegrasSociedade) {
  const cargos = ['PRESIDENTE', 'SECRETARIO', 'TESOUREIRO'];
  if (!regra.diretoria_reduzida) {
    cargos.push('VICE_PRESIDENTE');
    if (sigla !== 'UCP' || regra.segundo_secretario_ucp) cargos.push('SEGUNDO_SECRETARIO');
  }
  return cargos;
}

export function configuracaoOrgao(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor as Record<string, unknown> : {};
}
