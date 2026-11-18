import { faceDoLivro, reservarPosicao, totaisLivro } from './livro-paginacao';

const livro = { capacidade_folhas: 4, faces_por_folha: 2, reserva_exame: 2 };
type Registro = Parameters<typeof reservarPosicao>[1][number];

const abertura: Registro = {
  ordem: 1,
  natureza: 'ABERTURA',
  estado: 'EFETIVADO',
  posicao_inicio: 1,
  posicao_fim: 1,
};

describe('posição física e numeração do livro', () => {
  it('conta folhas inteiras, faces e atas com lacuna de reserva cancelada', () => {
    const registros: Registro[] = [
      abertura,
      { ordem: 2, natureza: 'ATA_ORIGINAL', estado: 'CANCELADO', posicao_inicio: 2, posicao_fim: 3 },
      { ordem: 3, natureza: 'ATA_ORIGINAL', estado: 'EFETIVADO', posicao_inicio: 4, posicao_fim: 5 },
    ];
    expect(faceDoLivro(livro, 4)).toEqual({ folha: 2, face: 'VERSO' });
    expect(faceDoLivro(livro, 5)).toEqual({ folha: 3, face: 'FRENTE' });
    expect(totaisLivro(livro, registros)).toMatchObject({
      folhas_utilizadas: 3,
      paginas_utilizadas: 3,
      saldo_folhas: 1,
      saldo_faces: 5,
      total_atas: 1,
      ultima_posicao: 5,
    });
  });

  it('reserva a ata inteira no limite e mantém duas faces de exame e uma de encerramento', () => {
    const ata = reservarPosicao(livro, [abertura], 'ATA_ORIGINAL', 4);
    expect(ata).toEqual({ ordem: 2, posicao_inicio: 2, posicao_fim: 5, numero_visivel_inicio: 1 });
    expect(() => reservarPosicao(livro, [abertura], 'ATA_ORIGINAL', 5)).toThrow('mesmo livro');
    const registros: Registro[] = [abertura, { ...ata, estado: 'EFETIVADO', natureza: 'ATA_ORIGINAL' }];
    const exame = reservarPosicao(livro, registros, 'EXAME', 2);
    expect(exame).toMatchObject({ posicao_inicio: 6, posicao_fim: 7, numero_visivel_inicio: 5 });
    expect(
      reservarPosicao(livro, [...registros, { ...exame, estado: 'EFETIVADO', natureza: 'EXAME' }], 'ENCERRAMENTO', 1),
    ).toMatchObject({ posicao_inicio: 8, posicao_fim: 8, numero_visivel_inicio: null });
  });
});
