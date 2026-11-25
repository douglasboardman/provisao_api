export function contextoPorExtenso(nome: string, nomeIgreja: string) {
  const contexto = nome.trim();
  const igreja = nomeIgreja.trim();
  if (contexto.toLocaleLowerCase('pt-BR').endsWith(igreja.toLocaleLowerCase('pt-BR'))) return contexto;
  return contexto + ' da ' + igreja;
}
