ALTER TABLE "solicitacao_acesso" ADD COLUMN "situacao_acesso" TEXT;
ALTER TABLE "solicitacao_acesso" ADD CONSTRAINT "solicitacao_acesso_situacao_check" CHECK ("situacao_acesso" IS NULL OR ("estado" = 'APROVADA' AND "situacao_acesso" IN ('CONVITE_PENDENTE', 'ATIVADA')));
ALTER TABLE "confirmacao_acesso" ADD COLUMN "cancelamento_hash" TEXT;
CREATE UNIQUE INDEX "confirmacao_acesso_cancelamento_hash_key" ON "confirmacao_acesso"("cancelamento_hash");
