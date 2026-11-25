import { linhasDoRol, type EventoDoRol } from './rol-assembleia';

it('indica uma única linha para conferência quando o acervo tem dois eventos sem ordem no mesmo dia', () => {
  const dia = new Date('2025-05-15');
  const pessoa = { pessoa_id: '1', nome: 'Ana', data_evento: dia, ordem_dia: null };
  const eventos: EventoDoRol[] = [{ ...pessoa, rol: 'COMUNGANTES' }, { ...pessoa, rol: 'NAO_COMUNGANTES' }];
  expect(linhasDoRol(eventos, dia)).toEqual([{ pessoa_id: '1', nome: 'Ana', categoria: 'CONFERIR' }]);
});
