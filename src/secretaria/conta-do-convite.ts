export const normalizarEmail = (email?: string | null) => email?.trim().toLowerCase() ?? '';

/** Um convite só dispensa login quando a pessoa não possui nenhuma conta. */
export function contaDoConvite<T extends { email_login: string; ativo: boolean }>(
  contas: readonly T[],
  emailIndividual: string,
  erro: () => Error,
): T | null {
  if (!contas.length) return null;
  const correspondentes = contas.filter(c => normalizarEmail(c.email_login) === emailIndividual);
  if (correspondentes.length !== 1 || !correspondentes[0].ativo) throw erro();
  return correspondentes[0];
}
