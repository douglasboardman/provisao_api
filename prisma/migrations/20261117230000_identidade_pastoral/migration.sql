-- CreateTable
CREATE TABLE "identidade_pastoral" (
    "id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identidade_pastoral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referencia_identidade_pastoral" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "oficial_id" TEXT NOT NULL,
    "identidade_id" TEXT NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" VARCHAR(1000) NOT NULL,
    "criado_por_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revogado_em" TIMESTAMP(3),
    "revogado_por_id" TEXT,
    "motivo_revogacao" VARCHAR(1000),

    CONSTRAINT "referencia_identidade_pastoral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "convite_identidade_pastoral" (
    "id" TEXT NOT NULL,
    "identidade_id" TEXT NOT NULL,
    "origem_igreja_id" TEXT NOT NULL,
    "destino_igreja_id" TEXT NOT NULL,
    "origem_referencia_id" TEXT NOT NULL,
    "destino_referencia_id" TEXT,
    "criado_por_id" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "consumido_em" TIMESTAMP(3),
    "revogado_em" TIMESTAMP(3),

    CONSTRAINT "convite_identidade_pastoral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "referencia_identidade_pastoral_igreja_id_oficial_id_idx" ON "referencia_identidade_pastoral"("igreja_id", "oficial_id");

-- CreateIndex
CREATE UNIQUE INDEX "referencia_identidade_pastoral_id_igreja_id_identidade_id_key" ON "referencia_identidade_pastoral"("id", "igreja_id", "identidade_id");

-- CreateIndex
CREATE UNIQUE INDEX "convite_identidade_pastoral_token_hash_key" ON "convite_identidade_pastoral"("token_hash");

-- CreateIndex
CREATE INDEX "convite_identidade_pastoral_origem_igreja_id_origem_referen_idx" ON "convite_identidade_pastoral"("origem_igreja_id", "origem_referencia_id");

-- AddForeignKey
ALTER TABLE "referencia_identidade_pastoral" ADD CONSTRAINT "referencia_identidade_pastoral_oficial_id_igreja_id_fkey" FOREIGN KEY ("oficial_id", "igreja_id") REFERENCES "oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "referencia_identidade_pastoral" ADD CONSTRAINT "referencia_identidade_pastoral_identidade_id_fkey" FOREIGN KEY ("identidade_id") REFERENCES "identidade_pastoral"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "referencia_identidade_pastoral" ADD CONSTRAINT "referencia_identidade_pastoral_criado_por_id_igreja_id_fkey" FOREIGN KEY ("criado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "referencia_identidade_pastoral" ADD CONSTRAINT "referencia_identidade_pastoral_revogado_por_id_igreja_id_fkey" FOREIGN KEY ("revogado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "convite_identidade_pastoral" ADD CONSTRAINT "convite_identidade_pastoral_identidade_id_fkey" FOREIGN KEY ("identidade_id") REFERENCES "identidade_pastoral"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "convite_identidade_pastoral" ADD CONSTRAINT "convite_identidade_pastoral_origem_referencia_id_origem_ig_fkey" FOREIGN KEY ("origem_referencia_id", "origem_igreja_id", "identidade_id") REFERENCES "referencia_identidade_pastoral"("id", "igreja_id", "identidade_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "convite_identidade_pastoral" ADD CONSTRAINT "convite_identidade_pastoral_destino_referencia_id_destino__fkey" FOREIGN KEY ("destino_referencia_id", "destino_igreja_id", "identidade_id") REFERENCES "referencia_identidade_pastoral"("id", "igreja_id", "identidade_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "convite_identidade_pastoral" ADD CONSTRAINT "convite_identidade_pastoral_criado_por_id_origem_igreja_id_fkey" FOREIGN KEY ("criado_por_id", "origem_igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "convite_identidade_pastoral" ADD CONSTRAINT "convite_identidade_pastoral_destino_igreja_id_fkey" FOREIGN KEY ("destino_igreja_id") REFERENCES "igreja"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "referencia_pastoral_oficial_ativo" ON "referencia_identidade_pastoral" ("igreja_id", "oficial_id") WHERE "revogado_em" IS NULL;
CREATE UNIQUE INDEX "referencia_pastoral_identidade_ativa" ON "referencia_identidade_pastoral" ("igreja_id", "identidade_id") WHERE "revogado_em" IS NULL;
ALTER TABLE "referencia_identidade_pastoral" ADD CONSTRAINT "referencia_pastoral_valida" CHECK (
  length(btrim("autoridade")) > 0 AND length(btrim("evidencia")) > 0 AND
  (("revogado_em" IS NULL AND "revogado_por_id" IS NULL AND "motivo_revogacao" IS NULL) OR
   ("revogado_em" IS NOT NULL AND "revogado_por_id" IS NOT NULL AND "motivo_revogacao" IS NOT NULL AND length(btrim("motivo_revogacao")) > 0))
);
ALTER TABLE "convite_identidade_pastoral" ADD CONSTRAINT "convite_pastoral_valido" CHECK (
  "origem_igreja_id" <> "destino_igreja_id" AND "expira_em" > "criado_em" AND "token_hash" ~ '^[0-9a-f]{64}$' AND
  (("consumido_em" IS NULL AND "destino_referencia_id" IS NULL) OR ("consumido_em" IS NOT NULL AND "destino_referencia_id" IS NOT NULL)) AND
  NOT ("consumido_em" IS NOT NULL AND "revogado_em" IS NOT NULL)
);
