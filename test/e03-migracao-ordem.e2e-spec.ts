import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../src/prisma/prisma.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;

integration('E03: migração de sequência de ocupações', () => {
  const prisma = new PrismaService();
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await prisma.$connect();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('preserva o limite civil dos registros anteriores e aceita sucessão no mesmo dia', async () => {
    const rollback = new Error('Reverter teste isolado');
    const arquivo = readFileSync(join(process.cwd(), 'prisma/migrations/20261119170000_ocupacao_ordem_dia/migration.sql'), 'utf8');
    await expect(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "ocupacao_cargo" ("id" text PRIMARY KEY, "cargo_id" text NOT NULL, "inicio" date NOT NULL, "fim" date, "termino_previsto" date, CONSTRAINT "ocupacao_cargo_periodo" CHECK (("fim" IS NULL OR "fim" > "inicio") AND ("termino_previsto" IS NULL OR "termino_previsto" >= "inicio"))) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`ALTER TABLE "ocupacao_cargo" ADD CONSTRAINT "cargo_sem_titulares_sobrepostos" EXCLUDE USING gist ("cargo_id" WITH =, daterange("inicio", LEAST("fim", "termino_previsto" + 1), '[)') WITH &&)`);
      await tx.$executeRawUnsafe(`INSERT INTO "ocupacao_cargo" (id,cargo_id,inicio,fim) VALUES ('antigo','cargo','2026-01-01','2026-06-01'), ('sucessor','cargo','2026-06-01',NULL)`);
      for (const comando of arquivo.split(';').map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(comando);
      const linhas = await tx.$queryRaw<Array<{ id: string; inicio_ordem: number; fim_ordem: number | null }>>`SELECT id, inicio_ordem, fim_ordem FROM ocupacao_cargo ORDER BY id`;
      expect(linhas).toEqual([{ id: 'antigo', inicio_ordem: 1, fim_ordem: 1 }, { id: 'sucessor', inicio_ordem: 1, fim_ordem: null }]);
      await tx.$executeRawUnsafe(`UPDATE "ocupacao_cargo" SET "fim"='2026-06-01', "fim_ordem"=2 WHERE "id"='sucessor'`);
      await tx.$executeRawUnsafe(`INSERT INTO "ocupacao_cargo" (id,cargo_id,inicio,inicio_ordem) VALUES ('novo','cargo','2026-06-01',2)`);
      const total = await tx.$queryRaw<Array<{ total: bigint }>>`SELECT count(*) AS total FROM ocupacao_cargo`;
      expect(Number(total[0].total)).toBe(3);
      throw rollback;
    })).rejects.toBe(rollback);
  });
  it('preserva os limites da participação legada ao introduzir sequência', async () => {
    const rollback = new Error('Reverter ensaio de participação');
    const arquivo = readFileSync(join(process.cwd(), 'prisma/migrations/20261120010000_conclusao_orgaos/migration.sql'), 'utf8').split('ALTER TABLE ato_orgao')[0];
    await expect(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE membro_orgao (id text PRIMARY KEY, orgao_id text NOT NULL, pessoa_id text NOT NULL, inicio date NOT NULL, fim date, CONSTRAINT membro_orgao_periodo CHECK (fim IS NULL OR fim > inicio)) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`ALTER TABLE membro_orgao ADD CONSTRAINT membro_orgao_sem_sobreposicao EXCLUDE USING gist (orgao_id WITH =, pessoa_id WITH =, daterange(inicio, fim, '[)') WITH &&)`);
      await tx.$executeRawUnsafe(`INSERT INTO membro_orgao VALUES ('anterior', 'orgao', 'pessoa', '2026-01-01', '2026-06-01'), ('atual', 'orgao', 'pessoa', '2026-06-01', NULL)`);
      for (const comando of arquivo.split(';').map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(comando);
      const linhas = await tx.$queryRaw<Array<{ id: string; inicio_ordem: number; fim_ordem: number | null }>>`SELECT id, inicio_ordem, fim_ordem FROM membro_orgao ORDER BY id`;
      expect(linhas).toEqual([{ id: 'anterior', inicio_ordem: 1, fim_ordem: 1 }, { id: 'atual', inicio_ordem: 1, fim_ordem: null }]);
      await tx.$executeRawUnsafe(`UPDATE membro_orgao SET fim = '2026-06-01', fim_ordem = 2 WHERE id = 'atual'`);
      await tx.$executeRawUnsafe(`INSERT INTO membro_orgao (id, orgao_id, pessoa_id, inicio, inicio_ordem) VALUES ('novo', 'orgao', 'pessoa', '2026-06-01', 2)`);
      expect((await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM membro_orgao`).length).toBe(3);
      throw rollback;
    })).rejects.toBe(rollback);
  });

});
