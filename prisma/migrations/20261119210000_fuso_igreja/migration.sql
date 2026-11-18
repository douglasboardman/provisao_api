CREATE TABLE "configuracao_fuso_igreja" (
  "igreja_id" TEXT NOT NULL,
  "fuso_iana" VARCHAR(100) NOT NULL,
  "atualizado_em" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "configuracao_fuso_igreja_pkey" PRIMARY KEY ("igreja_id"),
  CONSTRAINT "configuracao_fuso_igreja_nome" CHECK (length(trim("fuso_iana")) > 0),
  CONSTRAINT "configuracao_fuso_igreja_igreja_fkey" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

ALTER TABLE "requisicao_institucional" ADD COLUMN "fuso_igreja_id" TEXT;
ALTER TABLE "requisicao_institucional" ADD CONSTRAINT "requisicao_fuso_igreja_fkey" FOREIGN KEY ("fuso_igreja_id") REFERENCES "configuracao_fuso_igreja"("igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "requisicao_institucional"
  DROP CONSTRAINT "requisicao_alvo_compatível",
  ADD CONSTRAINT "requisicao_alvo_compatível" CHECK (
    ("tipo" IN ('COMPETENCIA_UNIDADES', 'ENCERRAMENTO_COMPETENCIA_UNIDADES') AND "competencia_id" IS NOT NULL AND "presidencia_id" IS NULL AND "fuso_igreja_id" IS NULL AND "resultado"->>'id' IS NOT DISTINCT FROM "competencia_id") OR
    ("tipo" IN ('PRESIDENCIA_CONSELHO', 'ENCERRAMENTO_PRESIDENCIA') AND "presidencia_id" IS NOT NULL AND "competencia_id" IS NULL AND "fuso_igreja_id" IS NULL AND "resultado"->>'id' IS NOT DISTINCT FROM "presidencia_id") OR
    ("tipo" = 'FUSO_IGREJA' AND "competencia_id" IS NULL AND "presidencia_id" IS NULL AND "fuso_igreja_id" IS NOT NULL AND "fuso_igreja_id" = "igreja_id" AND "resultado"->>'id' IS NOT DISTINCT FROM "igreja_id")
  );
