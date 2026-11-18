-- AlterTable
ALTER TABLE "requisicao_institucional" ADD COLUMN     "competencia_id" TEXT,
ADD COLUMN     "presidencia_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "presidencia_conselho_id_igreja_id_key" ON "presidencia_conselho"("id", "igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "competencia_unidades_id_igreja_id_key" ON "competencia_unidades"("id", "igreja_id");

-- Preserva os registros já feitos pelo incremento anterior; FKs recusam alvo ausente.
UPDATE "requisicao_institucional" SET "competencia_id" = "resultado"->>'id'
  WHERE "tipo" IN ('COMPETENCIA_UNIDADES', 'ENCERRAMENTO_COMPETENCIA_UNIDADES');
UPDATE "requisicao_institucional" SET "presidencia_id" = "resultado"->>'id'
  WHERE "tipo" IN ('PRESIDENCIA_CONSELHO', 'ENCERRAMENTO_PRESIDENCIA');

-- AddForeignKey
ALTER TABLE "requisicao_institucional" ADD CONSTRAINT "requisicao_institucional_competencia_id_igreja_id_fkey" FOREIGN KEY ("competencia_id", "igreja_id") REFERENCES "competencia_unidades"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "requisicao_institucional" ADD CONSTRAINT "requisicao_institucional_presidencia_id_igreja_id_fkey" FOREIGN KEY ("presidencia_id", "igreja_id") REFERENCES "presidencia_conselho"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "requisicao_institucional" ADD CONSTRAINT "requisicao_alvo_compatível" CHECK (
  ("tipo" IN ('COMPETENCIA_UNIDADES', 'ENCERRAMENTO_COMPETENCIA_UNIDADES') AND "competencia_id" IS NOT NULL AND "presidencia_id" IS NULL AND "resultado"->>'id' IS NOT DISTINCT FROM "competencia_id") OR
  ("tipo" IN ('PRESIDENCIA_CONSELHO', 'ENCERRAMENTO_PRESIDENCIA') AND "presidencia_id" IS NOT NULL AND "competencia_id" IS NULL AND "resultado"->>'id' IS NOT DISTINCT FROM "presidencia_id")
);

