-- AlterTable
ALTER TABLE "ato_orgao" ADD COLUMN     "hash_requisicao" CHAR(64),
ADD COLUMN     "idempotencia" VARCHAR(36);

-- CreateIndex
CREATE UNIQUE INDEX "ato_orgao_igreja_id_idempotencia_key" ON "ato_orgao"("igreja_id", "idempotencia");

ALTER TABLE "ato_orgao" ADD CONSTRAINT "ato_orgao_chave_integral" CHECK (
  ("idempotencia" IS NULL AND "hash_requisicao" IS NULL) OR
  ("idempotencia" IS NOT NULL AND "hash_requisicao" IS NOT NULL AND "idempotencia" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND "hash_requisicao" ~ '^[0-9a-f]{64}$')
);

