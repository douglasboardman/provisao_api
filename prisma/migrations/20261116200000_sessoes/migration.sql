CREATE TABLE "sessoes" (
  "id" TEXT NOT NULL,
  "usuario_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "auth_version" INTEGER NOT NULL,
  "expira_em" TIMESTAMP(3) NOT NULL,
  "revogada_em" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sessoes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sessoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sessoes_token_hash_key" ON "sessoes"("token_hash");
CREATE INDEX "sessoes_usuario_id_idx" ON "sessoes"("usuario_id");
