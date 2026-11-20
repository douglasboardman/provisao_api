BEGIN;

ALTER TABLE "oficial" ADD COLUMN "ativo" BOOLEAN NOT NULL DEFAULT true;

-- Os registros anteriores não tinham situação. Mantém ativo o mais recente
-- de cada pessoa e preserva os ofícios anteriores e suas relações.
WITH registros AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "igreja_id", "pessoa_id"
    ORDER BY "criado_em" DESC, "id" DESC
  ) AS posicao
  FROM "oficial"
)
UPDATE "oficial" o
SET "ativo" = false
FROM registros r
WHERE o."id" = r."id" AND r.posicao > 1;

CREATE UNIQUE INDEX "oficial_ativo_por_pessoa"
  ON "oficial" ("igreja_id", "pessoa_id")
  WHERE "ativo" = true;

COMMIT;
