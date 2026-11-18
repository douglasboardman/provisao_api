-- CreateEnum
CREATE TYPE "convencao_bissexto" AS ENUM ('DIA_28_FEVEREIRO', 'DIA_01_MARCO');

-- CreateTable
CREATE TABLE "politica_eleicao_oficial" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "versao" VARCHAR(100) NOT NULL,
    "fonte" VARCHAR(500) NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "idade_minima" INTEGER NOT NULL,
    "aniversario_bissexto" "convencao_bissexto" NOT NULL,
    "vigente_desde" DATE NOT NULL,
    "vigente_ate" DATE,
    "criado_por_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "politica_eleicao_oficial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conferencia_eleicao_oficial" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "politica_id" TEXT NOT NULL,
    "data_eleicao" DATE NOT NULL,
    "data_recepcao" DATE NOT NULL,
    "evidencia_recepcao" VARCHAR(1000) NOT NULL,
    "capacidade_confirmada" BOOLEAN NOT NULL,
    "evidencia_capacidade" VARCHAR(1000) NOT NULL,
    "excecao_transferencia" JSONB,
    "resultado" JSONB NOT NULL,
    "criado_por_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conferencia_eleicao_oficial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "politica_eleicao_oficial_id_igreja_id_key" ON "politica_eleicao_oficial"("id", "igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "politica_eleicao_oficial_igreja_id_versao_key" ON "politica_eleicao_oficial"("igreja_id", "versao");

-- CreateIndex
CREATE INDEX "conferencia_eleicao_oficial_igreja_id_pessoa_id_data_eleica_idx" ON "conferencia_eleicao_oficial"("igreja_id", "pessoa_id", "data_eleicao");

-- AddForeignKey
ALTER TABLE "politica_eleicao_oficial" ADD CONSTRAINT "politica_eleicao_oficial_igreja_id_fkey" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "politica_eleicao_oficial" ADD CONSTRAINT "politica_eleicao_oficial_criado_por_id_igreja_id_fkey" FOREIGN KEY ("criado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conferencia_eleicao_oficial" ADD CONSTRAINT "conferencia_eleicao_oficial_pessoa_id_igreja_id_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conferencia_eleicao_oficial" ADD CONSTRAINT "conferencia_eleicao_oficial_politica_id_igreja_id_fkey" FOREIGN KEY ("politica_id", "igreja_id") REFERENCES "politica_eleicao_oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conferencia_eleicao_oficial" ADD CONSTRAINT "conferencia_eleicao_oficial_criado_por_id_igreja_id_fkey" FOREIGN KEY ("criado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "politica_eleicao_oficial" ADD CONSTRAINT "politica_eleicao_campos_validos" CHECK (
  "idade_minima" BETWEEN 0 AND 120 AND length(btrim("fonte")) > 0 AND length(btrim("versao")) > 0
  AND length(btrim("autoridade")) > 0 AND ("vigente_ate" IS NULL OR "vigente_ate" >= "vigente_desde")
);
ALTER TABLE "politica_eleicao_oficial" ADD CONSTRAINT "politica_eleicao_sem_sobreposicao"
  EXCLUDE USING gist ("igreja_id" WITH =, daterange("vigente_desde", "vigente_ate", '[]') WITH &&);
ALTER TABLE "conferencia_eleicao_oficial" ADD CONSTRAINT "conferencia_eleicao_campos_validos" CHECK (
  "data_recepcao" <= "data_eleicao" AND length(btrim("evidencia_recepcao")) > 0
  AND (NOT "capacidade_confirmada" OR length(btrim("evidencia_capacidade")) > 0)
);
