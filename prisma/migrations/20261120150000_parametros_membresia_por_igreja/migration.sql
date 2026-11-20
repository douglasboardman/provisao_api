CREATE TABLE "parametro_membresia_igreja" (
  "igreja_id" TEXT NOT NULL,
  "regra_id" TEXT NOT NULL,
  "valores" JSONB NOT NULL CHECK (jsonb_typeof("valores") = 'array'),
  "updated_at" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("igreja_id", "regra_id"),
  CONSTRAINT "parametro_membresia_igreja_igreja_id_fkey"
    FOREIGN KEY ("igreja_id") REFERENCES "igreja" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "parametro_membresia_igreja_regra_id_fkey"
    FOREIGN KEY ("regra_id") REFERENCES "regras_relacao_enum" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "parametro_membresia_igreja_regra_id_idx" ON "parametro_membresia_igreja" ("regra_id");
