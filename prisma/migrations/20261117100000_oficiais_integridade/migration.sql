-- Exclusão transacional impede mandatos concorrentes para o mesmo ofício.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "mandato_oficial" ADD CONSTRAINT "mandato_sem_sobreposicao"
  EXCLUDE USING gist ("oficial_id" WITH =, daterange("data_posse", COALESCE("termino_efetivo", "termino_previsto"), '[]') WITH &&);

-- Uma restauração identifica o afastamento que encerra; a FK também confere igreja e oficial.
ALTER TABLE "evento_oficial" ADD COLUMN "evento_restaurado_id" TEXT;
CREATE UNIQUE INDEX "evento_oficial_evento_restaurado_id_key" ON "evento_oficial"("evento_restaurado_id");
CREATE UNIQUE INDEX "evento_oficial_id_igreja_id_oficial_id_key" ON "evento_oficial"("id", "igreja_id", "oficial_id");
CREATE UNIQUE INDEX "evento_oficial_evento_restaurado_id_igreja_id_oficial_id_key" ON "evento_oficial"("evento_restaurado_id", "igreja_id", "oficial_id");
ALTER TABLE "evento_oficial" ADD CONSTRAINT "evento_oficial_evento_restaurado_fkey"
  FOREIGN KEY ("evento_restaurado_id", "igreja_id", "oficial_id") REFERENCES "evento_oficial"("id", "igreja_id", "oficial_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "evento_oficial" ADD CONSTRAINT "restauracao_exige_evento" CHECK (
  ("tipo" = 'RESTAURACAO' AND "evento_restaurado_id" IS NOT NULL AND "evento_restaurado_id" <> "id") OR
  ("tipo" <> 'RESTAURACAO' AND "evento_restaurado_id" IS NULL)
);
