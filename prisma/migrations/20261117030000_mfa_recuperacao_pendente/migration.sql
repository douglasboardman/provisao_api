CREATE TABLE "mfa_recuperacao_pendente" (
  "usuario_id" TEXT NOT NULL,
  "sessao_id" TEXT NOT NULL,
  "codigos_cifrados" TEXT NOT NULL,
  "expira_em" TIMESTAMP(3) NOT NULL,
  "falhas" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recuperacao_pendente_pkey" PRIMARY KEY ("usuario_id"),
  CONSTRAINT "mfa_pendente_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "mfa_pendente_sessao_fkey" FOREIGN KEY ("sessao_id") REFERENCES "sessoes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
