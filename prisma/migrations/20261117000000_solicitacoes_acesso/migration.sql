CREATE TABLE "solicitacao_acesso" (
  "id" TEXT NOT NULL, "igreja_id" TEXT NOT NULL, "nome_usuario" TEXT NOT NULL,
  "email_login" TEXT NOT NULL, "estado" TEXT NOT NULL DEFAULT 'AGUARDA_CONFIRMACAO',
  "usuario_id" TEXT, "analisado_por" TEXT, "analisado_em" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "solicitacao_acesso_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "solicitacao_acesso_igreja_fkey" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "solicitacao_acesso_estado_check" CHECK ("estado" IN ('AGUARDA_CONFIRMACAO','EM_ANALISE','APROVADA','REJEITADA','CANCELADA'))
);
CREATE UNIQUE INDEX "solicitacao_acesso_pendente_key" ON "solicitacao_acesso"("igreja_id", "email_login") WHERE "estado" IN ('AGUARDA_CONFIRMACAO', 'EM_ANALISE');
CREATE INDEX "solicitacao_acesso_igreja_estado_idx" ON "solicitacao_acesso"("igreja_id", "estado");
CREATE TABLE "confirmacao_acesso" (
  "id" TEXT NOT NULL, "solicitacao_id" TEXT NOT NULL, "hash" TEXT NOT NULL,
  "expira_em" TIMESTAMP(3) NOT NULL, "consumido_em" TIMESTAMP(3), "revogado_em" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "confirmacao_acesso_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "confirmacao_acesso_solicitacao_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacao_acesso"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "confirmacao_acesso_hash_key" ON "confirmacao_acesso"("hash");
CREATE INDEX "confirmacao_acesso_solicitacao_id_idx" ON "confirmacao_acesso"("solicitacao_id");
ALTER TABLE "outbox_email" ALTER COLUMN "token_id" DROP NOT NULL;
ALTER TABLE "outbox_email" ADD COLUMN "confirmacao_id" TEXT;
ALTER TABLE "outbox_email" ADD CONSTRAINT "outbox_email_confirmacao_fkey" FOREIGN KEY ("confirmacao_id") REFERENCES "confirmacao_acesso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outbox_email" ADD CONSTRAINT "outbox_email_destino_check" CHECK (("token_id" IS NOT NULL)::integer + ("confirmacao_id" IS NOT NULL)::integer = 1);
CREATE UNIQUE INDEX "outbox_email_confirmacao_id_key" ON "outbox_email"("confirmacao_id");
