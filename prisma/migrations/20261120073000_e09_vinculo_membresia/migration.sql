CREATE TABLE "referencia_ata_membresia" (
  "id" TEXT NOT NULL,
  "igreja_id" TEXT NOT NULL,
  "evento_id" TEXT NOT NULL,
  "versao_id" TEXT,
  "referencia_externa" JSONB,
  "justificativa" TEXT NOT NULL,
  "sequencia" INTEGER NOT NULL,
  "registrado_por_id" TEXT NOT NULL,
  "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referencia_ata_membresia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referencia_ata_membresia_fonte_check" CHECK ("versao_id" IS NULL OR "referencia_externa" IS NULL),
  CONSTRAINT "referencia_ata_membresia_evento_fkey" FOREIGN KEY ("evento_id", "igreja_id") REFERENCES "eventos_membresia"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "referencia_ata_membresia_versao_fkey" FOREIGN KEY ("versao_id", "igreja_id") REFERENCES "documento_versao"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "referencia_ata_membresia_usuario_fkey" FOREIGN KEY ("registrado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "referencia_ata_membresia_igreja_id_evento_id_sequencia_key" ON "referencia_ata_membresia"("igreja_id", "evento_id", "sequencia");
CREATE INDEX "referencia_ata_membresia_igreja_id_versao_id_idx" ON "referencia_ata_membresia"("igreja_id", "versao_id");
