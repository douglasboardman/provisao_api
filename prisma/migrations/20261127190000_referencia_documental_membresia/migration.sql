ALTER TABLE "eventos_membresia"
  ADD COLUMN "referencia_documental" VARCHAR(1000),
  ADD CONSTRAINT "membresia_referencia_documental_preenchida"
    CHECK ("referencia_documental" IS NULL OR "referencia_documental" ~ '[^[:space:]]');
