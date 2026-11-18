-- CreateEnum
CREATE TYPE "fato_historico_oficial" AS ENUM ('ELEICAO', 'POSSE', 'ORDENACAO', 'VINCULO_PASTORAL', 'FIM_EXERCICIO');

-- CreateEnum
CREATE TYPE "estado_documental_historico" AS ENUM ('PENDENTE', 'EXTERNO_CONFERIDO');

-- CreateTable
CREATE TABLE "registro_historico_oficial" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "oficial_id" TEXT NOT NULL,
    "tipo" "fato_historico_oficial" NOT NULL,
    "data_evento" DATE,
    "data_descricao" VARCHAR(255),
    "situacao_documental" "estado_documental_historico" NOT NULL,
    "referencia_externa" VARCHAR(1000),
    "autoridade" VARCHAR(255),
    "idempotencia" UUID NOT NULL,
    "criado_por_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registro_historico_oficial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registro_historico_oficial_igreja_id_oficial_id_data_evento_idx" ON "registro_historico_oficial"("igreja_id", "oficial_id", "data_evento");

-- CreateIndex
CREATE UNIQUE INDEX "registro_historico_oficial_igreja_id_idempotencia_key" ON "registro_historico_oficial"("igreja_id", "idempotencia");

-- AddForeignKey
ALTER TABLE "registro_historico_oficial" ADD CONSTRAINT "registro_historico_oficial_oficial_id_igreja_id_fkey" FOREIGN KEY ("oficial_id", "igreja_id") REFERENCES "oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "registro_historico_oficial" ADD CONSTRAINT "registro_historico_oficial_criado_por_id_igreja_id_fkey" FOREIGN KEY ("criado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "registro_historico_oficial" ADD CONSTRAINT "registro_historico_evidencia" CHECK (
  ("data_descricao" IS NULL OR length(btrim("data_descricao")) > 0) AND
  ("autoridade" IS NULL OR length(btrim("autoridade")) > 0) AND
  ("referencia_externa" IS NULL OR length(btrim("referencia_externa")) > 0) AND
  ("situacao_documental" <> 'EXTERNO_CONFERIDO' OR ("referencia_externa" IS NOT NULL AND length(btrim("referencia_externa")) > 0))
);
