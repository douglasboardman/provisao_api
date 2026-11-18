ALTER TABLE "sessoes" ADD COLUMN "mfa_confirmada_em" TIMESTAMP(3);
ALTER TABLE "mfa_recuperacao" ADD COLUMN "reserva_sessao_id" TEXT;
ALTER TABLE "mfa_recuperacao" ADD COLUMN "reserva_ate" TIMESTAMP(3);
CREATE UNIQUE INDEX "mfa_recuperacao_reserva_sessao_id_key" ON "mfa_recuperacao"("reserva_sessao_id");
ALTER TABLE "mfa_recuperacao" ADD CONSTRAINT "mfa_recuperacao_reserva_sessao_fkey" FOREIGN KEY ("reserva_sessao_id") REFERENCES "sessoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
