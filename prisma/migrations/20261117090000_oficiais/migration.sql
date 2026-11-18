-- CreateEnum
CREATE TYPE "oficio_tipo" AS ENUM ('DIACONO', 'PRESBITERO_REGENTE', 'PRESBITERO_DOCENTE');

-- CreateEnum
CREATE TYPE "oficial_evento_tipo" AS ENUM ('ORDENACAO', 'LICENCA', 'SUSPENSAO', 'DISPONIBILIDADE', 'RESTAURACAO', 'DEPOSICAO');

-- CreateTable
CREATE TABLE "oficial" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "tipo" "oficio_tipo" NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oficial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mandato_oficial" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "oficial_id" TEXT NOT NULL,
    "data_eleicao" DATE NOT NULL,
    "data_posse" DATE NOT NULL,
    "termino_previsto" DATE NOT NULL,
    "termino_efetivo" DATE,
    "motivo_encerramento" TEXT,
    "autoridade" TEXT NOT NULL,
    "evidencia" TEXT NOT NULL,
    "avaliacao_eleicao" JSONB NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mandato_oficial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evento_oficial" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "oficial_id" TEXT NOT NULL,
    "tipo" "oficial_evento_tipo" NOT NULL,
    "data_efeito" DATE NOT NULL,
    "ordem" INTEGER NOT NULL,
    "autoridade" TEXT NOT NULL,
    "evidencia" TEXT NOT NULL,
    "observacoes" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evento_oficial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vinculo_pastoral" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "oficial_id" TEXT NOT NULL,
    "modalidade" TEXT NOT NULL,
    "concilio" TEXT NOT NULL,
    "ato" TEXT NOT NULL,
    "data_inicio" DATE NOT NULL,
    "data_fim" DATE,
    "exercicio_institucional" BOOLEAN NOT NULL DEFAULT false,
    "evidencia" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vinculo_pastoral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oficial_id_igreja_id_key" ON "oficial"("id", "igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "oficial_igreja_id_pessoa_id_tipo_key" ON "oficial"("igreja_id", "pessoa_id", "tipo");

-- CreateIndex
CREATE INDEX "mandato_oficial_igreja_id_oficial_id_data_posse_idx" ON "mandato_oficial"("igreja_id", "oficial_id", "data_posse");

-- CreateIndex
CREATE INDEX "evento_oficial_igreja_id_oficial_id_data_efeito_idx" ON "evento_oficial"("igreja_id", "oficial_id", "data_efeito");

-- CreateIndex
CREATE UNIQUE INDEX "evento_oficial_oficial_id_data_efeito_ordem_key" ON "evento_oficial"("oficial_id", "data_efeito", "ordem");

-- CreateIndex
CREATE INDEX "vinculo_pastoral_igreja_id_oficial_id_data_inicio_idx" ON "vinculo_pastoral"("igreja_id", "oficial_id", "data_inicio");

-- AddForeignKey
ALTER TABLE "oficial" ADD CONSTRAINT "oficial_pessoa_id_igreja_id_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mandato_oficial" ADD CONSTRAINT "mandato_oficial_oficial_id_igreja_id_fkey" FOREIGN KEY ("oficial_id", "igreja_id") REFERENCES "oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "evento_oficial" ADD CONSTRAINT "evento_oficial_oficial_id_igreja_id_fkey" FOREIGN KEY ("oficial_id", "igreja_id") REFERENCES "oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vinculo_pastoral" ADD CONSTRAINT "vinculo_pastoral_oficial_id_igreja_id_fkey" FOREIGN KEY ("oficial_id", "igreja_id") REFERENCES "oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Restrições locais que não exigem preencher dados antigos ou instalar extensões.
ALTER TABLE "mandato_oficial" ADD CONSTRAINT "mandato_datas_validas" CHECK (
  "data_eleicao" <= "data_posse" AND "data_posse" <= "termino_previsto"
  AND ("termino_efetivo" IS NULL OR ("termino_efetivo" >= "data_posse" AND "termino_efetivo" <= "termino_previsto"))
  AND (("termino_efetivo" IS NULL AND "motivo_encerramento" IS NULL) OR
       ("termino_efetivo" IS NOT NULL AND "motivo_encerramento" IS NOT NULL AND length(btrim("motivo_encerramento")) > 0))
  AND length(btrim("autoridade")) > 0 AND length(btrim("evidencia")) > 0
);
ALTER TABLE "evento_oficial" ADD CONSTRAINT "evento_oficial_dados_validos" CHECK (
  "ordem" > 0 AND length(btrim("autoridade")) > 0 AND length(btrim("evidencia")) > 0
);
ALTER TABLE "vinculo_pastoral" ADD CONSTRAINT "vinculo_pastoral_dados_validos" CHECK (
  ("data_fim" IS NULL OR "data_fim" >= "data_inicio") AND length(btrim("modalidade")) > 0
  AND length(btrim("concilio")) > 0 AND length(btrim("ato")) > 0 AND length(btrim("evidencia")) > 0
);
