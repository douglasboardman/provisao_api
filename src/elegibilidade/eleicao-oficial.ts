/** Dados e política são evidências conferidas, não inferências do cadastro de pessoas. */
export type BaseEleicao = {
  dataEleicao: string;
  dataRecepcao: string;
  evidenciaRecepcao: string;
  dataNascimento: string;
  capacidadeConfirmada: boolean;
  evidenciaCapacidade: string;
  excecaoTransferencia?: { oficialTransferido: boolean; autoridade: string; evidencia: string };
};
export type PoliticaEleicao = { idadeMinima: number; fonte: string; versao: string; vigenteDesde: string; aniversarioBissexto: '28_FEVEREIRO' | '01_MARCO' };

type Requisito = { requisito: string; atendido: boolean; motivo: string };
function civil(valor: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new TypeError('Data civil inválida.');
  const data = new Date(`${valor}T00:00:00.000Z`);
  if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== valor) throw new TypeError('Data civil inválida.');
  return data;
}
/** A convenção de ano bissexto pertence à política institucional versionada. */
function aniversario(data: Date, anos: number, convencao: PoliticaEleicao['aniversarioBissexto']): Date {
  const ano = data.getUTCFullYear() + anos, mes = data.getUTCMonth(), dia = data.getUTCDate();
  const fimMes = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  if (dia > fimMes && convencao === '01_MARCO') return new Date(Date.UTC(ano, mes + 1, 1));
  return new Date(Date.UTC(ano, mes, Math.min(dia, fimMes)));
}
export function avaliarEleicaoOficial(base: BaseEleicao, politica: PoliticaEleicao) {
  const eleicao = civil(base.dataEleicao), recepcao = civil(base.dataRecepcao), nascimento = civil(base.dataNascimento), vigencia = civil(politica.vigenteDesde);
  if (!Number.isInteger(politica.idadeMinima) || politica.idadeMinima < 0 || politica.idadeMinima > 120 || !politica.fonte.trim() || !politica.versao.trim() || !['28_FEVEREIRO', '01_MARCO'].includes(politica.aniversarioBissexto) || vigencia > eleicao) {
    throw new TypeError('Política normativa inválida ou ainda não vigente.');
  }
  if (recepcao > eleicao || nascimento > eleicao) throw new TypeError('Recepção ou nascimento posterior à eleição.');
  const ex = base.excecaoTransferencia;
  const excecaoValida = !!ex && ex.oficialTransferido && !!ex.autoridade.trim() && !!ex.evidencia.trim();
  const prazoCompleto = aniversario(recepcao, 1, politica.aniversarioBissexto) <= eleicao;
  const requisitos: Requisito[] = [
    { requisito: 'recepcao_documentada', atendido: !!base.evidenciaRecepcao.trim(), motivo: 'A recepção deve possuir evidência documental.' },
    { requisito: 'idade', atendido: aniversario(nascimento, politica.idadeMinima, politica.aniversarioBissexto) <= eleicao, motivo: `Idade mínima de ${politica.idadeMinima} anos conforme a política informada.` },
    { requisito: 'capacidade', atendido: base.capacidadeConfirmada && !!base.evidenciaCapacidade.trim(), motivo: 'Capacidade deve ser confirmada com evidência.' },
    { requisito: 'prazo_recepcao', atendido: prazoCompleto || excecaoValida, motivo: prazoCompleto ? 'Prazo de um ano completado.' : excecaoValida ? 'Exceção documentada para oficial transferido.' : 'Prazo não completado e sem exceção de transferência documentada.' },
  ];
  return { requisitosAtendidos: requisitos.every(r => r.atendido), requisitos, politica: { ...politica }, excecaoAplicada: !prazoCompleto && excecaoValida };
}
