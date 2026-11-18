CREATE UNIQUE INDEX "vinculo_pastoral_id_igreja_id_key" ON "vinculo_pastoral"("id", "igreja_id");
CREATE TABLE "referencia_ata_oficial" (
 "id" TEXT PRIMARY KEY, "igreja_id" TEXT NOT NULL, "mandato_id" TEXT, "vinculo_id" TEXT,
 "ato" VARCHAR(30) NOT NULL, "versao_id" TEXT, "referencia_externa" JSONB,
 "justificativa" TEXT NOT NULL, "sequencia" INTEGER NOT NULL, "registrado_por_id" TEXT NOT NULL,
 "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "referencia_oficial_alvo_check" CHECK (("mandato_id" IS NOT NULL AND "vinculo_id" IS NULL AND "ato" IN ('ELEICAO', 'POSSE', 'ENCERRAMENTO')) OR ("mandato_id" IS NULL AND "vinculo_id" IS NOT NULL AND "ato" IN ('INICIO', 'ENCERRAMENTO'))),
 CONSTRAINT "referencia_oficial_fonte_check" CHECK ("versao_id" IS NULL OR "referencia_externa" IS NULL),
 CONSTRAINT "referencia_oficial_mandato_fkey" FOREIGN KEY ("mandato_id", "igreja_id") REFERENCES "mandato_oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "referencia_oficial_vinculo_fkey" FOREIGN KEY ("vinculo_id", "igreja_id") REFERENCES "vinculo_pastoral"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "referencia_oficial_versao_fkey" FOREIGN KEY ("versao_id", "igreja_id") REFERENCES "documento_versao"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "referencia_oficial_usuario_fkey" FOREIGN KEY ("registrado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "referencia_ata_oficial_igreja_id_mandato_id_ato_sequencia_key" ON "referencia_ata_oficial"("igreja_id", "mandato_id", "ato", "sequencia");
CREATE UNIQUE INDEX "referencia_ata_oficial_igreja_id_vinculo_id_ato_sequencia_key" ON "referencia_ata_oficial"("igreja_id", "vinculo_id", "ato", "sequencia");
CREATE INDEX "referencia_ata_oficial_igreja_id_versao_id_idx" ON "referencia_ata_oficial"("igreja_id", "versao_id");
