import { randomUUID } from 'node:crypto';
import { configuracaoReuniao, calcularQuorum, validarIntervalo } from './regras-modelo-reuniao';
import { dadosConsolidadosAta } from './pendencias-tramitacao';
import { conteudoSchema, reuniaoDadosSchema } from './secretaria.dto';

const config = configuracaoReuniao.parse({
  tipo: 'Extraordinária',
  natureza: 'Eleitoral',
  obrigatoria: false,
  periodicidade: 'Conforme a necessidade',
  referencia: 'Membros comungantes',
  orgaos_participantes: [],
  primeira: '1/3',
  segunda: 'Qualquer número',
  antecedencia_dias: 7,
  intervalo_minutos: 10080,
  minimo_anual: null,
  colegiado: 'Assembleia',
  fundamentacao: 'Estatuto local',
  observacao: '',
});
const dados = reuniaoDadosSchema.parse({
  modelo_reuniao_id: randomUUID(),
  modelo_reuniao: { finalidade: 'Eleição', revisao: 1, configuracao: config },
  formato: 'Presencial',
  carater: 'Regular',
  convocacao: 'Primeira',
  modalidade: 'AGE',
  data: '2023-07-09',
  local: 'Local previsto',
  pauta: 'Eleição',
  restrito: false,
  universo_informado: 0,
  quorum_minimo: 0,
  resultado: '',
  participantes: Array.from({ length: 4 }, () => ({
    pessoa_id: randomUUID(),
    papeis: ['PARTICIPANTE'],
    presente: true,
  })),
});
const ata = conteudoSchema.parse({
  teor: 'Eleição',
  campos: {},
  arrolados: [],
  anexos: [],
  efetivos: {
    inicio: '2023-07-09T09:58:00-03:00',
    fim: '2023-07-09T10:59:00-03:00',
    local: 'Local da assembleia',
    presentes: 33,
    habilitados_presentes: 31,
    universo: 91,
  },
});

describe('Modelos e realização da reunião', () => {
  it('preserva os quatro participantes identificados e replica a contagem das assinaturas', () => {
    const r = dadosConsolidadosAta(dados, ata);
    expect(r).toMatchObject({
      total_presentes: 33,
      quorum_minimo: 31,
      quorum_conferido: true,
      local: 'Local previsto',
      local_efetivo: ata.efetivos!.local,
      inicio: ata.efetivos!.inicio,
      fim: ata.efetivos!.fim,
    });
    expect(r.participantes).toHaveLength(4);
  });
  it('aplica o quórum da convocação selecionada e distingue assinantes de habilitados', () => {
    const menor = { ...ata, efetivos: { ...ata.efetivos, habilitados_presentes: 30 } };
    expect(() => dadosConsolidadosAta(dados, menor)).toThrow(/quórum/);
    expect(dadosConsolidadosAta({ ...dados, convocacao: 'Segunda' }, menor).quorum_minimo).toBe(1);
  });
  it('permite rascunho parcial e exige todos os dados efetivos na formalização', () => {
    const minuta = { ...ata, efetivos: { presentes: 33 } };
    expect(conteudoSchema.safeParse(minuta).success).toBe(true);
    expect(() => dadosConsolidadosAta(dados, minuta)).toThrow();
  });
  it('observa os sete dias da AGE e o intervalo de quinze minutos de uma plenária', () => {
    const inicial = { data: '2026-11-10', horario_previsto: '09:00' };
    expect(() => validarIntervalo(inicial, { data: '2026-11-17', horario_previsto: '08:59' }, 10080)).toThrow();
    validarIntervalo(inicial, { data: '2026-11-17', horario_previsto: '09:00' }, 10080);
    validarIntervalo(inicial, { ...inicial, horario_previsto: '09:15' }, 15);
  });
  it('requer composição pastoral e presbiteral e aplica a maioria administrativa', () => {
    const e = {
      universo: 7,
      habilitados_presentes: 3,
      regentes_exercicio: 6,
      pastores_presentes: 1,
      regentes_presentes: 2,
    };
    expect(calcularQuorum('Composição do Conselho', e)).toEqual({ minimo: 3, atingido: true });
    expect(calcularQuorum('Composição e maioria absoluta', e)).toEqual({ minimo: 4, atingido: false });
    expect(calcularQuorum('Composição do Conselho', { ...e, pastores_presentes: 0 })).toMatchObject({
      atingido: false,
    });
  });
});
