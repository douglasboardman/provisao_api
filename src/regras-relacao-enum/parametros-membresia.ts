import { parametro_membresia_igreja, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;
type ValorLocal = { id: string; valor_classificador: string; valor_classificado: string };
type Regra = Prisma.regras_relacao_enumGetPayload<{ include: { valores: true } }>;

export function regraComValoresLocais(regra: Omit<Regra, 'valores'>, local: parametro_membresia_igreja): Regra {
  return {
    ...regra,
    updated_at: local.updated_at > regra.updated_at ? local.updated_at : regra.updated_at,
    valores: (local.valores as ValorLocal[]).map(valor => ({
      ...valor, regra_id: regra.id, created_at: local.updated_at,
    })),
  };
}

export async function consultarRegrasDaIgreja(tx: Tx, igreja: string): Promise<Regra[]> {
  const regras = await tx.regras_relacao_enum.findMany({
    where: { modulo: 'membresia' },
    include: { valores: true, parametros_igreja: { where: { igreja_id: igreja } } },
    orderBy: { nome: 'asc' },
  });
  return regras.map(({ parametros_igreja: [local], ...regra }) => local ? regraComValoresLocais(regra, local) : regra);
}

export function valoresDaRegra(regras: Regra[], nome: string, classificador: string): string[] {
  return regras.find(regra => regra.nome === nome)?.valores
    .filter(valor => valor.valor_classificador === classificador)
    .map(valor => valor.valor_classificado) ?? [];
}

export async function bloquearRegrasMembresia(tx: Tx, igreja: string) {
  await tx.$queryRaw`SELECT id FROM regras_relacao_enum WHERE modulo = 'membresia' ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT v.id FROM relacao_enum_valores v JOIN regras_relacao_enum r ON r.id = v.regra_id WHERE r.modulo = 'membresia' ORDER BY v.id FOR SHARE OF v`;
  await tx.$queryRaw`SELECT regra_id FROM parametro_membresia_igreja WHERE igreja_id = ${igreja} ORDER BY regra_id FOR SHARE`;
}
