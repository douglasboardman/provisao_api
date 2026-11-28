import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const quantidade = z.number().int().min(0).max(1000000);
export const regraQuorum = z.enum([
  'Qualquer número',
  'Maioria absoluta',
  '1/3',
  '1/5',
  '2/3',
  'Composição do Conselho',
  'Composição e maioria absoluta',
  'Por matéria',
  'Pendente',
  'Não prevista',
]);
export const configuracaoReuniao = z
  .strictObject({
    tipo: z.enum(['Ordinária', 'Extraordinária', 'A confirmar']),
    natureza: z.enum(['Eclesiástica', 'Administrativa', 'Eleitoral', 'Judicial', 'Mista']),
    obrigatoria: z.boolean(),
    periodicidade: z.enum(['Conforme a necessidade', 'Semanal', 'Mensal', 'Trimestral', 'Semestral', 'Anual']),
    referencia: z.enum([
      'Membros comungantes',
      'Membros comungantes e não comungantes',
      'Integrantes do órgão/unidade',
      'Integrantes de vários órgãos/unidades',
    ]),
    orgaos_participantes: z.array(z.uuid()).max(100),
    primeira: regraQuorum,
    segunda: regraQuorum,
    antecedencia_dias: quantidade.nullable(),
    intervalo_minutos: quantidade.nullable(),
    minimo_anual: quantidade.nullable(),
    colegiado: z.string().trim().min(1).max(200),
    fundamentacao: z.string().trim().min(1).max(1500),
    observacao: z.string().trim().max(1500),
  })
  .refine(
    (c) => (c.referencia === 'Integrantes de vários órgãos/unidades') === !!c.orgaos_participantes.length,
    'Selecione os demais órgãos para o quórum conjunto.',
  );
export const retratoModeloReuniao = z.strictObject({
  finalidade: z.string().max(255),
  revisao: z.number().int().positive(),
  configuracao: configuracaoReuniao,
});
const camposEfetivos = z.strictObject({
  inicio: z.iso.datetime({ offset: true }),
  fim: z.iso.datetime({ offset: true }),
  local: z.string().trim().min(1).max(255),
  presentes: quantidade,
  habilitados_presentes: quantidade,
  universo: quantidade,
  minimo_declarado: quantidade.optional(),
  pastores_presentes: quantidade.optional(),
  regentes_presentes: quantidade.optional(),
  regentes_exercicio: quantidade.optional(),
});
export const rascunhoEfetivos = camposEfetivos.partial();
export const efetivosAta = camposEfetivos.refine(
  (v) =>
    Date.parse(v.inicio) <= Date.parse(v.fim) &&
    v.habilitados_presentes <= v.presentes &&
    v.habilitados_presentes <= v.universo &&
    (v.pastores_presentes ?? 0) + (v.regentes_presentes ?? 0) <= v.habilitados_presentes &&
    (v.regentes_presentes ?? 0) <= (v.regentes_exercicio ?? Infinity),
  'Confira os horários e as contagens da ata.',
);

type Contagens = Pick<
  z.infer<typeof efetivosAta>,
  'universo' | 'habilitados_presentes' | 'regentes_presentes' | 'pastores_presentes' | 'regentes_exercicio'
>;
export function calcularQuorum(regra: z.infer<typeof regraQuorum>, e: Contagens, urgente = false) {
  const universo = e.universo;
  if (regra === 'Pendente' || regra === 'Não prevista') return null;
  if (!universo) return { minimo: 1, atingido: false };
  const maioria = Math.floor(universo / 2) + 1;
  let minimo: number;
  let composicao = true;
  switch (regra) {
    case 'Qualquer número':
      minimo = 1;
      break;
    case 'Maioria absoluta':
      minimo = maioria;
      break;
    case '1/3':
      minimo = Math.ceil(universo / 3);
      break;
    case '1/5':
      minimo = Math.ceil(universo / 5);
      break;
    case '2/3':
      minimo = Math.ceil((2 * universo) / 3);
      break;
    default: {
      if (
        e.regentes_exercicio === undefined ||
        e.pastores_presentes === undefined ||
        e.regentes_presentes === undefined
      )
        return null;
      const regentes = urgente && e.regentes_exercicio <= 3 ? 1 : Math.max(2, Math.ceil(e.regentes_exercicio / 3));
      minimo = regra === 'Composição e maioria absoluta' ? Math.max(1 + regentes, maioria) : 1 + regentes;
      composicao = e.pastores_presentes >= 1 && e.regentes_presentes >= regentes;
    }
  }
  return { minimo, atingido: composicao && e.habilitados_presentes >= minimo };
}

export function quorumDoModelo(
  dados: { modelo_reuniao?: z.infer<typeof retratoModeloReuniao>; convocacao?: string; carater?: string },
  contagens: Contagens,
) {
  const config = dados.modelo_reuniao?.configuracao;
  if (!config) return null;
  return calcularQuorum(
    dados.convocacao === 'Segunda' ? config.segunda : config.primeira,
    contagens,
    dados.carater === 'Urgente' && config.natureza !== 'Judicial',
  );
}

export function validarIntervalo(
  primeira: { data: string; horario_previsto?: string },
  segunda: { data: string; horario_previsto?: string },
  minutos: number | null,
) {
  const instante = (v: typeof primeira) => Date.parse(v.data + 'T' + (v.horario_previsto ?? '00:00') + ':00Z');
  const distancia = instante(segunda) - instante(primeira);
  if (distancia <= 0 || distancia < (minutos ?? 0) * 60000)
    throw new BadRequestException('Intervalo entre as convocações incompatível com o modelo.');
}
