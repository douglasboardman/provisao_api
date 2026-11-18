ALTER TABLE "sessoes" ADD COLUMN "mfa_metodo" TEXT;
ALTER TABLE "sessoes" ADD COLUMN "mfa_autenticado_em" TIMESTAMP(3);
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_mfa_metodo_check" CHECK ("mfa_metodo" IS NULL OR "mfa_metodo" IN ('totp', 'recovery'));
