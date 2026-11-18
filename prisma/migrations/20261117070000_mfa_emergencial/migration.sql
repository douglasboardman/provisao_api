ALTER TABLE "usuarios" ADD COLUMN "mfa_reinscricao_obrigatoria" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "mfa_recuperacao_emergencial" (
  "id" TEXT NOT NULL, "igreja_id" TEXT NOT NULL, "usuario_id" TEXT NOT NULL,
  "nonce_hash" TEXT NOT NULL, "chave_fingerprint" TEXT NOT NULL,
  "autoridade_externa" VARCHAR(120) NOT NULL, "motivo" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recuperacao_emergencial_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_emergencial_usuario_igreja_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "mfa_recuperacao_emergencial_nonce_hash_key" ON "mfa_recuperacao_emergencial"("nonce_hash");
CREATE INDEX "mfa_recuperacao_emergencial_igreja_usuario_idx" ON "mfa_recuperacao_emergencial"("igreja_id", "usuario_id");
