CREATE TABLE "mfa_credencial" (
  "usuario_id" TEXT NOT NULL,
  "segredo_cifrado" TEXT NOT NULL,
  "estado" TEXT NOT NULL DEFAULT 'PENDENTE',
  "expira_em" TIMESTAMP(3),
  "ultimo_passo" INTEGER,
  "falhas" INTEGER NOT NULL DEFAULT 0,
  "bloqueado_ate" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mfa_credencial_pkey" PRIMARY KEY ("usuario_id"),
  CONSTRAINT "mfa_credencial_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "mfa_credencial_estado_check" CHECK ("estado" IN ('PENDENTE', 'ATIVO'))
);
CREATE TABLE "mfa_recuperacao" (
  "id" TEXT NOT NULL,
  "usuario_id" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "consumido_em" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recuperacao_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_recuperacao_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "mfa_recuperacao_usuario_hash_key" ON "mfa_recuperacao"("usuario_id", "hash");
