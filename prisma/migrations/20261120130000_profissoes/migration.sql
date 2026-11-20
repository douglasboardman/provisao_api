CREATE TABLE "profissoes" (
  "id" TEXT PRIMARY KEY,
  "igreja_id" TEXT NOT NULL,
  "nome" VARCHAR(120) NOT NULL CHECK (length(btrim("nome")) > 0),
  CONSTRAINT "profissoes_igreja_id_fkey" FOREIGN KEY ("igreja_id") REFERENCES "igreja" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "profissoes_id_igreja_id_key" ON "profissoes" ("id", "igreja_id");
CREATE UNIQUE INDEX "profissoes_igreja_nome_unico" ON "profissoes" ("igreja_id", lower("nome"));

ALTER TABLE "pessoas"
  ADD COLUMN "profissao_id" TEXT,
  ADD CONSTRAINT "pessoas_profissao_igreja_fkey" FOREIGN KEY ("profissao_id", "igreja_id")
    REFERENCES "profissoes" ("id", "igreja_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "pessoas_igreja_id_profissao_id_idx" ON "pessoas" ("igreja_id", "profissao_id");
