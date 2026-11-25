export function agruparPorPessoa<T extends { pessoa_id: string }>(registros: T[]) {
  const grupos = new Map<string, T[]>();
  for (const registro of registros) {
    const grupo = grupos.get(registro.pessoa_id);
    if (grupo) grupo.push(registro);
    else grupos.set(registro.pessoa_id, [registro]);
  }
  return grupos;
}
