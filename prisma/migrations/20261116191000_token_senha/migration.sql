CREATE TABLE "token_senha" (
  "id" TEXT NOT NULL,
  "usuario_id" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "finalidade" TEXT NOT NULL,
  "auth_version" INTEGER NOT NULL,
  "expira_em" TIMESTAMP(3) NOT NULL,
  "consumido_em" TIMESTAMP(3),
  "revogado_em" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "token_senha_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "token_senha_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "token_senha_finalidade_check" CHECK ("finalidade" IN ('password_setup', 'password_reset'))
);
CREATE UNIQUE INDEX "token_senha_hash_key" ON "token_senha"("hash");
CREATE INDEX "token_senha_usuario_id_idx" ON "token_senha"("usuario_id");
