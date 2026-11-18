import { BadRequestException } from '@nestjs/common';
import type { livro_atas, registro_livro, registro_livro_natureza } from '@prisma/client';

type Capacidade = Pick<livro_atas, 'capacidade_folhas' | 'faces_por_folha' | 'reserva_exame'>;
type Registro = Pick<registro_livro, 'ordem' | 'estado' | 'natureza' | 'posicao_inicio' | 'posicao_fim'>;

export function termoDeLivro(natureza: registro_livro_natureza) {
  return natureza === 'ABERTURA' || natureza === 'ENCERRAMENTO';
}

export function capacidadeEmFaces(livro: Capacidade) {
  return livro.capacidade_folhas * livro.faces_por_folha;
}

export function faceDoLivro(livro: Capacidade, posicao: number) {
  return {
    folha: Math.ceil(posicao / livro.faces_por_folha),
    face: livro.faces_por_folha === 2 && posicao % 2 === 0 ? 'VERSO' : 'FRENTE',
  };
}

export function fimOcupado(registros: Registro[]) {
  return registros.reduce(
    (fim, r) => (r.estado === 'CANCELADO' && termoDeLivro(r.natureza) ? fim : Math.max(fim, r.posicao_fim)),
    0,
  );
}

export function totaisLivro(livro: Capacidade, registros: Registro[]) {
  const efetivos = registros.filter((r) => r.estado === 'EFETIVADO');
  const folhas = new Set<number>();
  let paginas = 0;
  for (const r of efetivos) {
    paginas += r.posicao_fim - r.posicao_inicio + 1;
    const inicio = faceDoLivro(livro, r.posicao_inicio).folha;
    const fim = faceDoLivro(livro, r.posicao_fim).folha;
    for (let folha = inicio; folha <= fim; folha++) folhas.add(folha);
  }
  return {
    paginas_utilizadas: paginas,
    folhas_utilizadas: folhas.size,
    saldo_folhas: livro.capacidade_folhas - folhas.size,
    saldo_faces: capacidadeEmFaces(livro) - paginas,
    total_atas: efetivos.filter((r) => r.natureza === 'ATA_ORIGINAL').length,
    pendencias: registros.filter((r) => r.estado === 'RESERVADO').length,
    ultima_posicao: fimOcupado(registros),
  };
}

export function reservarPosicao(
  livro: Capacidade,
  registros: Registro[],
  natureza: registro_livro_natureza,
  paginas: number,
) {
  const termo = termoDeLivro(natureza);
  if (termo && paginas !== 1)
    throw new BadRequestException('O termo e suas assinaturas devem caber em uma face do livro.');
  const posicao_inicio = natureza === 'ABERTURA' ? 1 : fimOcupado(registros) + 1;
  const posicao_fim = posicao_inicio + paginas - 1;
  const exameConsumido = registros
    .filter((r) => r.natureza === 'EXAME')
    .reduce((s, r) => s + r.posicao_fim - r.posicao_inicio + 1, 0);
  const margemExames = Math.max(0, livro.reserva_exame - exameConsumido);
  const limite =
    capacidadeEmFaces(livro) -
    (termo ? 0 : 1) -
    (natureza === 'ATA_ORIGINAL' || natureza === 'OUTRO_AUTORIZADO' ? margemExames : 0);
  if (posicao_fim > limite)
    throw new BadRequestException(
      'O documento inteiro e o espaço reservado aos termos e exames devem caber no mesmo livro.',
    );
  return {
    ordem: registros.reduce((ordem, r) => Math.max(ordem, r.ordem), 0) + 1,
    posicao_inicio,
    posicao_fim,
    numero_visivel_inicio: termo ? null : posicao_inicio - 1,
  };
}
