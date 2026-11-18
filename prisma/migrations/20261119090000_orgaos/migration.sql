-- CreateEnum
CREATE TYPE "orgao_tipo" AS ENUM ('CONSELHO', 'JUNTA', 'UNIDADE_MINISTERIAL');

-- CreateEnum
CREATE TYPE "orgao_constituicao" AS ENUM ('OFICIAL', 'ELEICAO', 'DESIGNACAO');

-- CreateTable
CREATE TABLE "orgao_interno" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "tipo" "orgao_tipo" NOT NULL,
    "constituicao" "orgao_constituicao" NOT NULL,
    "nome" VARCHAR(255) NOT NULL,
    "sigla" VARCHAR(40),
    "finalidade" TEXT NOT NULL,
    "data_criacao" DATE NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criador_id" TEXT NOT NULL,
    "instituidor_id" TEXT NOT NULL,
    "evidencia_instituicao" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orgao_interno_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cargo_orgao" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "orgao_id" TEXT NOT NULL,
    "nome" VARCHAR(120) NOT NULL,
    "codigo" VARCHAR(80) NOT NULL,
    "permite_acumulacao" BOOLEAN NOT NULL DEFAULT false,
    "ativo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cargo_orgao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membro_orgao" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "orgao_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "inicio" DATE NOT NULL,
    "fim" DATE,

    CONSTRAINT "membro_orgao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocupacao_cargo" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "orgao_id" TEXT NOT NULL,
    "cargo_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "inicio" DATE NOT NULL,
    "fim" DATE,
    "termino_previsto" DATE,

    CONSTRAINT "ocupacao_cargo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ato_orgao" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "orgao_id" TEXT NOT NULL,
    "operador_id" TEXT NOT NULL,
    "tipo" VARCHAR(60) NOT NULL,
    "data_efeito" DATE NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" TEXT NOT NULL,
    "detalhes" JSONB NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ato_orgao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orgao_interno_igreja_id_ativo_idx" ON "orgao_interno"("igreja_id", "ativo");

-- CreateIndex
CREATE UNIQUE INDEX "orgao_interno_id_igreja_id_key" ON "orgao_interno"("id", "igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "cargo_orgao_id_igreja_id_orgao_id_key" ON "cargo_orgao"("id", "igreja_id", "orgao_id");

-- CreateIndex
CREATE UNIQUE INDEX "cargo_orgao_orgao_id_codigo_key" ON "cargo_orgao"("orgao_id", "codigo");

-- CreateIndex
CREATE INDEX "membro_orgao_igreja_id_orgao_id_pessoa_id_idx" ON "membro_orgao"("igreja_id", "orgao_id", "pessoa_id");

-- CreateIndex
CREATE INDEX "ocupacao_cargo_igreja_id_orgao_id_pessoa_id_idx" ON "ocupacao_cargo"("igreja_id", "orgao_id", "pessoa_id");

-- CreateIndex
CREATE INDEX "ato_orgao_igreja_id_orgao_id_data_efeito_idx" ON "ato_orgao"("igreja_id", "orgao_id", "data_efeito");

-- AddForeignKey
ALTER TABLE "orgao_interno" ADD CONSTRAINT "orgao_interno_igreja_id_fkey" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgao_interno" ADD CONSTRAINT "orgao_interno_criador_id_igreja_id_fkey" FOREIGN KEY ("criador_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orgao_interno" ADD CONSTRAINT "orgao_interno_instituidor_id_igreja_id_fkey" FOREIGN KEY ("instituidor_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cargo_orgao" ADD CONSTRAINT "cargo_orgao_orgao_id_igreja_id_fkey" FOREIGN KEY ("orgao_id", "igreja_id") REFERENCES "orgao_interno"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membro_orgao" ADD CONSTRAINT "membro_orgao_orgao_id_igreja_id_fkey" FOREIGN KEY ("orgao_id", "igreja_id") REFERENCES "orgao_interno"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membro_orgao" ADD CONSTRAINT "membro_orgao_pessoa_id_igreja_id_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ocupacao_cargo" ADD CONSTRAINT "ocupacao_cargo_cargo_id_igreja_id_orgao_id_fkey" FOREIGN KEY ("cargo_id", "igreja_id", "orgao_id") REFERENCES "cargo_orgao"("id", "igreja_id", "orgao_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ocupacao_cargo" ADD CONSTRAINT "ocupacao_cargo_pessoa_id_igreja_id_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ato_orgao" ADD CONSTRAINT "ato_orgao_orgao_id_igreja_id_fkey" FOREIGN KEY ("orgao_id", "igreja_id") REFERENCES "orgao_interno"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ato_orgao" ADD CONSTRAINT "ato_orgao_operador_id_igreja_id_fkey" FOREIGN KEY ("operador_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Garantias que o Prisma não expressa. Não preenchem dados existentes.
CREATE UNIQUE INDEX "orgao_oficial_ativo_por_igreja" ON "orgao_interno" ("igreja_id", "tipo")
  WHERE "ativo" AND "tipo" IN ('CONSELHO', 'JUNTA');
ALTER TABLE "orgao_interno" ADD CONSTRAINT "orgao_constituicao_compativel" CHECK (
  ("tipo" IN ('CONSELHO', 'JUNTA') AND "constituicao" = 'OFICIAL') OR
  ("tipo" = 'UNIDADE_MINISTERIAL' AND "constituicao" IN ('ELEICAO', 'DESIGNACAO'))
);
ALTER TABLE "orgao_interno" ADD CONSTRAINT "orgao_dados_obrigatorios" CHECK (
  length(trim("nome")) > 0 AND length(trim("finalidade")) > 0 AND length(trim("evidencia_instituicao")) > 0
);
ALTER TABLE "membro_orgao" ADD CONSTRAINT "membro_orgao_periodo" CHECK ("fim" IS NULL OR "fim" > "inicio");
ALTER TABLE "ocupacao_cargo" ADD CONSTRAINT "ocupacao_cargo_periodo" CHECK (
  ("fim" IS NULL OR "fim" > "inicio") AND ("termino_previsto" IS NULL OR "termino_previsto" >= "inicio")
);
ALTER TABLE "ato_orgao" ADD CONSTRAINT "ato_orgao_evidencia" CHECK (length(trim("autoridade")) > 0 AND length(trim("evidencia")) > 0);
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "membro_orgao" ADD CONSTRAINT "membro_orgao_sem_sobreposicao"
  EXCLUDE USING gist ("orgao_id" WITH =, "pessoa_id" WITH =, daterange("inicio", "fim", '[)') WITH &&);
ALTER TABLE "ocupacao_cargo" ADD CONSTRAINT "cargo_sem_titulares_sobrepostos"
  EXCLUDE USING gist ("cargo_id" WITH =, daterange("inicio", LEAST("fim", "termino_previsto" + 1), '[)') WITH &&);

