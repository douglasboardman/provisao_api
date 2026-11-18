ALTER TABLE "convite_identidade_pastoral" ADD COLUMN "autoridade" VARCHAR(255), ADD COLUMN "evidencia" VARCHAR(1000);
-- Preserva convites anteriores sem inventar fundamento; novos fluxos exigem os dois campos.
ALTER TABLE "convite_identidade_pastoral" ADD CONSTRAINT "convite_pastoral_fundamento" CHECK (
  ("autoridade" IS NULL AND "evidencia" IS NULL) OR
  ("autoridade" IS NOT NULL AND length(btrim("autoridade")) > 0 AND "evidencia" IS NOT NULL AND length(btrim("evidencia")) > 0)
);
