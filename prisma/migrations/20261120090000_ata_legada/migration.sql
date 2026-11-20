ALTER TYPE "documento_estado" ADD VALUE 'LEGADA_CONFERIDA';

ALTER TABLE "documento_versao"
  ALTER COLUMN "modelo_versao_id" DROP NOT NULL,
  ADD COLUMN "numero_original" VARCHAR(100),
  ADD COLUMN "folhas_legadas" VARCHAR(80),
  ADD CONSTRAINT "documento_versao_origem_coerente" CHECK (
    ("modelo_versao_id" IS NOT NULL AND "numero_original" IS NULL AND "folhas_legadas" IS NULL)
    OR ("modelo_versao_id" IS NULL AND ("fonte_congelada" ? 'legado') IS TRUE)
  ),
  ADD CONSTRAINT "documento_versao_folhas_legadas_com_livro" CHECK (
    "folhas_legadas" IS NULL OR "livro_id" IS NOT NULL
  );

CREATE UNIQUE INDEX "ata_legada_numero_data_uq"
  ON "documento_versao" ("igreja_id", "contexto_id", "data_documento", "numero_original");

-- Arrolados, anexo e resoluções são inseridos antes do congelamento na mesma transação.
CREATE FUNCTION conferir_congelamento_ata_legada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM documento_versao WHERE id = NEW.id AND congelado_em IS NULL) THEN
    RAISE EXCEPTION 'Ata legada precisa ser congelada ao concluir o cadastro' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER conferir_congelamento_ata_legada
AFTER INSERT OR UPDATE ON documento_versao DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.modelo_versao_id IS NULL AND NEW.congelado_em IS NULL)
EXECUTE FUNCTION conferir_congelamento_ata_legada();

CREATE OR REPLACE FUNCTION e04_preservar_versao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.congelado_em IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.modelo_versao_id IS NULL
      AND (to_jsonb(OLD) - 'livro_id' - 'folhas_legadas') = (to_jsonb(NEW) - 'livro_id' - 'folhas_legadas') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Versão documental congelada é imutável' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
