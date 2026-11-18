import assert = require('node:assert/strict');
import { LancamentosService } from '../src/lancamentos/lancamentos.service';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  if (
    !/^postgresql:\/\/provisao_test:provisao_test@127\.0\.0\.1:55439\/e10_legado_[a-f0-9]{8}\?schema=public$/.test(
      process.env.DATABASE_URL ?? '',
    )
  ) {
    throw new Error('Use o banco sintético E10 anterior à migração.');
  }
  const prisma = new PrismaService();
  try {
    const servico = new LancamentosService(prisma);
    const igrejas = ['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002'];
    const balancos = await Promise.all([
      servico.balanco(igrejas[0], 1, 2026),
      servico.balanco(igrejas[0], 2, 2026),
      servico.balanco(igrejas[1], 1, 2026),
    ]);
    const resumo = balancos.map(({ mes, ano, total_receitas, total_despesas, saldo, lancamentos }) => ({
      mes,
      ano,
      total_receitas,
      total_despesas,
      saldo,
      quantidade: lancamentos.length,
    }));
    assert.deepEqual(
      resumo.map((b) => [b.total_receitas, b.total_despesas, b.saldo, b.quantidade]),
      [
        [125.45, 30.25, 95.2, 2],
        [39.99, 0, 39.99, 1],
        [0, 20, -20, 1],
      ],
    );
    process.stdout.write(JSON.stringify(resumo, null, 2) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((erro) => {
  process.stderr.write(String(erro) + '\n');
  process.exitCode = 1;
});
