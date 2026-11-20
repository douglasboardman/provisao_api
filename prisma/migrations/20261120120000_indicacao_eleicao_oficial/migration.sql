CREATE TABLE "indicacao_eleicao_oficial" (
  "id" TEXT PRIMARY KEY,
  "igreja_id" TEXT NOT NULL,
  "pessoa_id" TEXT NOT NULL,
  "oficio" "oficio_tipo" NOT NULL CHECK ("oficio" IN ('DIACONO', 'PRESBITERO_REGENTE')),
  "ata_conselho_versao_id" TEXT NOT NULL,
  "data_assembleia" DATE NOT NULL,
  "registrado_por_id" TEXT NOT NULL,
  "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas" ("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("ata_conselho_versao_id", "igreja_id") REFERENCES "documento_versao" ("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("registrado_por_id", "igreja_id") REFERENCES "usuarios" ("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "indicacao_eleicao_oficial_id_igreja_id_key" ON "indicacao_eleicao_oficial" ("id", "igreja_id");
CREATE UNIQUE INDEX "indicacao_eleicao_pessoa_oficio_assembleia_key" ON "indicacao_eleicao_oficial" ("igreja_id", "pessoa_id", "oficio", "data_assembleia");
CREATE INDEX "indicacao_eleicao_oficial_igreja_id_data_assembleia_idx" ON "indicacao_eleicao_oficial" ("igreja_id", "data_assembleia");

ALTER TABLE "mandato_oficial"
  ADD COLUMN "indicacao_id" TEXT,
  ADD CONSTRAINT "mandato_oficial_indicacao_id_igreja_id_fkey" FOREIGN KEY ("indicacao_id", "igreja_id") REFERENCES "indicacao_eleicao_oficial" ("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "mandato_origem_documental" CHECK ("indicacao_id" IS NULL OR "conferencia_id" IS NULL);
CREATE UNIQUE INDEX "mandato_oficial_indicacao_id_key" ON "mandato_oficial" ("indicacao_id");
CREATE UNIQUE INDEX "mandato_oficial_indicacao_id_igreja_id_key" ON "mandato_oficial" ("indicacao_id", "igreja_id");
