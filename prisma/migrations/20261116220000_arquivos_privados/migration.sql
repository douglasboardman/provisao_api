ALTER TYPE "logs_atividades_acao" ADD VALUE IF NOT EXISTS 'DOWNLOAD';
CREATE UNIQUE INDEX "usuarios_id_igreja_id_key" ON "usuarios"("id", "igreja_id");
CREATE TABLE "arquivo_privado" (
  "id" TEXT NOT NULL,
  "igreja_id" TEXT NOT NULL,
  "usuario_id" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "tamanho" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "arquivo_privado_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "arquivo_privado_usuario_igreja_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "arquivo_privado_usuario_igreja_idx" ON "arquivo_privado"("usuario_id", "igreja_id");
