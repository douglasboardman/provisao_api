CREATE TABLE "outbox_email" (
  "id" TEXT NOT NULL,
  "token_id" TEXT NOT NULL,
  "payload" TEXT,
  "estado" TEXT NOT NULL DEFAULT 'PENDENTE',
  "tentativas" INTEGER NOT NULL DEFAULT 0,
  "proxima_tentativa" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reserva_id" TEXT,
  "reserva_ate" TIMESTAMP(3),
  "ultimo_erro" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enviado_em" TIMESTAMP(3),
  CONSTRAINT "outbox_email_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_email_token_fkey" FOREIGN KEY ("token_id") REFERENCES "token_senha"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "outbox_email_estado_check" CHECK ("estado" IN ('PENDENTE', 'PROCESSANDO', 'ENVIADO', 'CANCELADO', 'FALHOU'))
);
CREATE UNIQUE INDEX "outbox_email_token_id_key" ON "outbox_email"("token_id");
CREATE INDEX "outbox_email_fila_idx" ON "outbox_email"("estado", "proxima_tentativa");
