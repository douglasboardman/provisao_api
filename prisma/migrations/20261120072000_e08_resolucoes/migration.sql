-- CreateEnum
CREATE TYPE "resolucao_resultado" AS ENUM ('APROVADA', 'APROVADA_COM_ALTERACOES', 'REJEITADA', 'RETIRADA', 'ADIADA');

-- CreateTable
CREATE TABLE "resolucao" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "assunto" VARCHAR(255) NOT NULL,
    "texto_proposta" TEXT,
    "texto_deliberado" TEXT,
    "resultado" "resolucao_resultado" NOT NULL,
    "eficaz" BOOLEAN NOT NULL DEFAULT false,
    "data_efeito" DATE,
    "votacao_secreta" BOOLEAN NOT NULL DEFAULT false,
    "apuracao" JSONB,

    CONSTRAINT "resolucao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolucao_proponente" (
    "resolucao_id" TEXT NOT NULL,
    "arrolado_id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,

    CONSTRAINT "resolucao_proponente_pkey" PRIMARY KEY ("resolucao_id","arrolado_id")
);

-- CreateTable
CREATE TABLE "resolucao_dissidente" (
    "resolucao_id" TEXT NOT NULL,
    "arrolado_id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,

    CONSTRAINT "resolucao_dissidente_pkey" PRIMARY KEY ("resolucao_id","arrolado_id")
);

-- CreateIndex
CREATE INDEX "resolucao_igreja_id_resultado_idx" ON "resolucao"("igreja_id", "resultado");

-- CreateIndex
CREATE UNIQUE INDEX "resolucao_versao_id_ordem_key" ON "resolucao"("versao_id", "ordem");

-- CreateIndex
CREATE UNIQUE INDEX "resolucao_escopo_key" ON "resolucao"("id", "igreja_id", "contexto_id", "versao_id");

-- CreateIndex
CREATE INDEX "resolucao_proponente_arrolado_id_idx" ON "resolucao_proponente"("arrolado_id");

-- CreateIndex
CREATE INDEX "resolucao_dissidente_arrolado_id_idx" ON "resolucao_dissidente"("arrolado_id");

-- CreateIndex
CREATE INDEX "documento_versao_igreja_id_contexto_id_data_documento_idx" ON "documento_versao"("igreja_id", "contexto_id", "data_documento");

-- AddForeignKey
ALTER TABLE "resolucao" ADD CONSTRAINT "resolucao_versao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "resolucao_proponente" ADD CONSTRAINT "proponente_resolucao_fkey" FOREIGN KEY ("resolucao_id", "igreja_id", "contexto_id", "versao_id") REFERENCES "resolucao"("id", "igreja_id", "contexto_id", "versao_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "resolucao_proponente" ADD CONSTRAINT "proponente_arrolado_fkey" FOREIGN KEY ("arrolado_id", "igreja_id", "contexto_id", "versao_id") REFERENCES "arrolado_documento"("id", "igreja_id", "contexto_id", "versao_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "resolucao_dissidente" ADD CONSTRAINT "dissidente_resolucao_fkey" FOREIGN KEY ("resolucao_id", "igreja_id", "contexto_id", "versao_id") REFERENCES "resolucao"("id", "igreja_id", "contexto_id", "versao_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "resolucao_dissidente" ADD CONSTRAINT "dissidente_arrolado_fkey" FOREIGN KEY ("arrolado_id", "igreja_id", "contexto_id", "versao_id") REFERENCES "arrolado_documento"("id", "igreja_id", "contexto_id", "versao_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Invariantes de eficácia e redação
ALTER TABLE resolucao
  ADD CONSTRAINT resolucao_ordem_positiva CHECK (ordem > 0),
  ADD CONSTRAINT resolucao_texto_registrado CHECK (texto_proposta IS NOT NULL OR texto_deliberado IS NOT NULL),
  ADD CONSTRAINT resolucao_texto_aprovado CHECK (
    resultado NOT IN ('APROVADA', 'APROVADA_COM_ALTERACOES') OR texto_deliberado IS NOT NULL
  ),
  ADD CONSTRAINT resolucao_redacao_alterada CHECK (
    resultado <> 'APROVADA_COM_ALTERACOES' OR (texto_proposta IS NOT NULL AND texto_proposta <> texto_deliberado)
  ),
  ADD CONSTRAINT resolucao_eficacia CHECK (
    (NOT eficaz OR resultado IN ('APROVADA', 'APROVADA_COM_ALTERACOES')) AND (data_efeito IS NULL OR eficaz)
  );

CREATE FUNCTION e08_preservar_resolucao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  origem TEXT;
  destino TEXT;
  versao RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN origem := OLD.versao_id; END IF;
  IF TG_OP <> 'DELETE' THEN destino := NEW.versao_id; END IF;
  FOR versao IN
    SELECT id, congelado_em
    FROM documento_versao WHERE id IN (origem, destino) ORDER BY id FOR UPDATE
  LOOP
    IF versao.congelado_em IS NOT NULL THEN
      RAISE EXCEPTION 'Resoluções de versão congelada são imutáveis' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER e08_preservar_resolucao BEFORE INSERT OR UPDATE OR DELETE ON resolucao
FOR EACH ROW EXECUTE FUNCTION e08_preservar_resolucao();
CREATE TRIGGER e08_preservar_proponente BEFORE INSERT OR UPDATE OR DELETE ON resolucao_proponente
FOR EACH ROW EXECUTE FUNCTION e08_preservar_resolucao();
CREATE TRIGGER e08_preservar_dissidente BEFORE INSERT OR UPDATE OR DELETE ON resolucao_dissidente
FOR EACH ROW EXECUTE FUNCTION e08_preservar_resolucao();

CREATE FUNCTION e08_proteger_votacao_secreta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'resolucao' THEN
    IF NEW.votacao_secreta AND EXISTS (SELECT 1 FROM resolucao_dissidente WHERE resolucao_id = NEW.id) THEN
      RAISE EXCEPTION 'Votação secreta não admite dissidência nominal' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM resolucao WHERE id = NEW.resolucao_id AND votacao_secreta) THEN
    RAISE EXCEPTION 'Votação secreta não admite dissidência nominal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e08_votacao_resolucao BEFORE UPDATE ON resolucao
FOR EACH ROW EXECUTE FUNCTION e08_proteger_votacao_secreta();
CREATE TRIGGER e08_votacao_dissidente BEFORE INSERT OR UPDATE ON resolucao_dissidente
FOR EACH ROW EXECUTE FUNCTION e08_proteger_votacao_secreta();
