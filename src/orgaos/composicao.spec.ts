import { comporOrgao, OficialApurado } from './composicao';

describe('composição derivada de órgão oficial', () => {
  it('considera exercício e tipo, reúne ofícios da mesma pessoa e sinaliza incerteza', () => {
    const registros: OficialApurado[] = [
      { pessoa_id: '1', sexo: 'MASCULINO', tipo: 'PRESBITERO_DOCENTE', situacao: 'EM_EXERCICIO', revisao_pendente: false },
      { pessoa_id: '1', sexo: 'MASCULINO', tipo: 'PRESBITERO_REGENTE', situacao: 'EM_EXERCICIO', revisao_pendente: true },
      { pessoa_id: '2', sexo: 'MASCULINO', tipo: 'PRESBITERO_REGENTE', situacao: 'FORA_DE_EXERCICIO', revisao_pendente: false },
      { pessoa_id: '3', sexo: 'MASCULINO', tipo: 'DIACONO', situacao: 'EM_EXERCICIO', revisao_pendente: false },
      { pessoa_id: '4', sexo: 'FEMININO', tipo: 'PRESBITERO_REGENTE', situacao: 'EM_EXERCICIO', revisao_pendente: false },
      { pessoa_id: '5', sexo: 'MASCULINO', tipo: 'PRESBITERO_REGENTE', situacao: 'INDETERMINADA', revisao_pendente: false },
    ];
    expect(comporOrgao('CONSELHO', registros)).toEqual({ membros: [{ pessoa_id: '1', oficios: ['PRESBITERO_DOCENTE', 'PRESBITERO_REGENTE'], revisao_pendente: true }], situacao_indeterminada: ['5'] });
    expect(comporOrgao('JUNTA', registros).membros.map(m => m.pessoa_id)).toEqual(['3']);
  });
});
