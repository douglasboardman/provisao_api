BEGIN;
ALTER TABLE documento_versao ADD COLUMN legada_superada boolean NOT NULL DEFAULT false;
DROP INDEX ata_legada_numero_data_uq;
CREATE UNIQUE INDEX ata_legada_numero_data_uq ON documento_versao
  (igreja_id, contexto_id, data_documento, numero_original) WHERE NOT legada_superada;

CREATE OR REPLACE FUNCTION e04_preservar_versao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.congelado_em IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.modelo_versao_id IS NULL AND NOT OLD.legada_superada THEN
      IF NEW.legada_superada AND (to_jsonb(OLD) - 'legada_superada') = (to_jsonb(NEW) - 'legada_superada') THEN
        RETURN NEW;
      END IF;
      IF (to_jsonb(OLD) - 'livro_id' - 'folhas_legadas') = (to_jsonb(NEW) - 'livro_id' - 'folhas_legadas') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Versão documental congelada é imutável' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
COMMIT;
