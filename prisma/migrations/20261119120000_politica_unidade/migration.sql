-- AlterTable
ALTER TABLE "ocupacao_cargo" ADD COLUMN     "politica_unidade_id" TEXT;

-- CreateTable
CREATE TABLE "politica_unidade" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "orgao_id" TEXT NOT NULL,
    "versao" VARCHAR(100) NOT NULL,
    "fonte" VARCHAR(500) NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" TEXT NOT NULL,
    "inicio" DATE NOT NULL,
    "fim" DATE NOT NULL,
    "prazo_maximo_meses" INTEGER NOT NULL,
    "registrado_por" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "politica_unidade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "politica_unidade_igreja_id_orgao_id_inicio_idx" ON "politica_unidade"("igreja_id", "orgao_id", "inicio");

-- CreateIndex
CREATE UNIQUE INDEX "politica_unidade_id_igreja_id_orgao_id_key" ON "politica_unidade"("id", "igreja_id", "orgao_id");

-- CreateIndex
CREATE UNIQUE INDEX "politica_unidade_orgao_id_versao_key" ON "politica_unidade"("orgao_id", "versao");

-- AddForeignKey
ALTER TABLE "ocupacao_cargo" ADD CONSTRAINT "ocupacao_cargo_politica_unidade_id_igreja_id_orgao_id_fkey" FOREIGN KEY ("politica_unidade_id", "igreja_id", "orgao_id") REFERENCES "politica_unidade"("id", "igreja_id", "orgao_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "politica_unidade" ADD CONSTRAINT "politica_unidade_orgao_id_igreja_id_fkey" FOREIGN KEY ("orgao_id", "igreja_id") REFERENCES "orgao_interno"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "politica_unidade" ADD CONSTRAINT "politica_unidade_registrado_por_igreja_id_fkey" FOREIGN KEY ("registrado_por", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "politica_unidade" ADD CONSTRAINT "politica_unidade_campos_validos" CHECK (
  "inicio" <= "fim" AND "prazo_maximo_meses" BETWEEN 1 AND 120 AND
  length(trim("versao")) > 0 AND length(trim("fonte")) > 0 AND length(trim("autoridade")) > 0 AND length(trim("evidencia")) > 0
);
ALTER TABLE "politica_unidade" ADD CONSTRAINT "politica_unidade_periodos_distintos" EXCLUDE USING gist ("orgao_id" WITH =, daterange("inicio", "fim", '[]') WITH &&);
CREATE FUNCTION proteger_politica_unidade_utilizada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ocupacao_cargo" WHERE "politica_unidade_id" = OLD."id" AND "igreja_id" = OLD."igreja_id" AND "orgao_id" = OLD."orgao_id") THEN
    RAISE EXCEPTION 'Política utilizada em ocupação deve ser preservada';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "politica_unidade_proteger_uso" BEFORE UPDATE OR DELETE ON "politica_unidade" FOR EACH ROW EXECUTE FUNCTION proteger_politica_unidade_utilizada();

