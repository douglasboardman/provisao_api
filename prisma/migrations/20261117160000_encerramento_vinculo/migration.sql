-- Uma conferência não serve como eleição para dois mandatos distintos.
CREATE UNIQUE INDEX "mandato_oficial_conferencia_id_key" ON "mandato_oficial"("conferencia_id");
CREATE UNIQUE INDEX "mandato_oficial_conferencia_id_igreja_id_key" ON "mandato_oficial"("conferencia_id", "igreja_id");
ALTER TABLE "vinculo_pastoral" ADD COLUMN "motivo_fim" TEXT, ADD COLUMN "autoridade_fim" TEXT, ADD COLUMN "evidencia_fim" TEXT;
-- Registros anteriores podem não conter dados do encerramento; nunca inventá-los.
ALTER TABLE "vinculo_pastoral" ADD CONSTRAINT "vinculo_detalhes_fim" CHECK (
  ("motivo_fim" IS NULL AND "autoridade_fim" IS NULL AND "evidencia_fim" IS NULL) OR
  ("data_fim" IS NOT NULL AND "motivo_fim" IS NOT NULL AND length(btrim("motivo_fim")) > 0
   AND "autoridade_fim" IS NOT NULL AND length(btrim("autoridade_fim")) > 0
   AND "evidencia_fim" IS NOT NULL AND length(btrim("evidencia_fim")) > 0)
);
