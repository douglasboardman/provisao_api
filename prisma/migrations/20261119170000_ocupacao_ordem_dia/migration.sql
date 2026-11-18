-- AlterTable
ALTER TABLE "ocupacao_cargo" ADD COLUMN     "fim_ordem" INTEGER,
ADD COLUMN     "inicio_ordem" INTEGER NOT NULL DEFAULT 1;

-- As datas anteriores eram limites civis no início do dia, sem ordem intradiária.
UPDATE "ocupacao_cargo" SET "fim_ordem" = 1 WHERE "fim" IS NOT NULL;
ALTER TABLE "ocupacao_cargo" DROP CONSTRAINT "cargo_sem_titulares_sobrepostos";
ALTER TABLE "ocupacao_cargo" DROP CONSTRAINT "ocupacao_cargo_periodo";
ALTER TABLE "ocupacao_cargo" ADD CONSTRAINT "ocupacao_cargo_periodo" CHECK (
  "inicio_ordem" BETWEEN 1 AND 9999 AND
  (("fim" IS NULL AND "fim_ordem" IS NULL) OR
   ("fim" IS NOT NULL AND "fim_ordem" IS NOT NULL AND "fim_ordem" BETWEEN 1 AND 9999 AND
    ("fim" > "inicio" OR ("fim" = "inicio" AND "fim_ordem" > "inicio_ordem")))) AND
  ("termino_previsto" IS NULL OR "termino_previsto" >= "inicio")
);
ALTER TABLE "ocupacao_cargo" ADD CONSTRAINT "cargo_sem_titulares_sobrepostos" EXCLUDE USING gist (
  "cargo_id" WITH =,
  int8range(
    (("inicio" - DATE '2000-01-01')::bigint * 10000 + "inicio_ordem"),
    LEAST(
      (("fim" - DATE '2000-01-01')::bigint * 10000 + "fim_ordem"),
      ((("termino_previsto" - DATE '2000-01-01')::bigint + 1) * 10000 + 1)
    ), '[)'
  ) WITH &&
);

