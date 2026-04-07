/*
  Warnings:

  - You are about to drop the column `descritivo_despesa_id` on the `lancamentos` table. All the data in the column will be lost.
  - You are about to drop the column `descritivo_receita_id` on the `lancamentos` table. All the data in the column will be lost.
  - You are about to drop the column `destinacao_id` on the `lancamentos` table. All the data in the column will be lost.
  - You are about to drop the `descritivos_despesa` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `descritivos_receita` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `destinacoes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `tipos_despesa` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `tipos_receita` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "descritivos_despesa" DROP CONSTRAINT "descritivos_despesa_ibfk_1";

-- DropForeignKey
ALTER TABLE "descritivos_receita" DROP CONSTRAINT "descritivos_receita_ibfk_1";

-- DropForeignKey
ALTER TABLE "destinacoes" DROP CONSTRAINT "destinacoes_ibfk_1";

-- DropForeignKey
ALTER TABLE "lancamentos" DROP CONSTRAINT "lancamentos_ibfk_2";

-- DropForeignKey
ALTER TABLE "lancamentos" DROP CONSTRAINT "lancamentos_ibfk_3";

-- DropForeignKey
ALTER TABLE "lancamentos" DROP CONSTRAINT "lancamentos_ibfk_4";

-- DropIndex
DROP INDEX "lancamentos_descritivo_despesa_id";

-- DropIndex
DROP INDEX "lancamentos_descritivo_receita_id";

-- DropIndex
DROP INDEX "lancamentos_destinacao_id";

-- AlterTable
ALTER TABLE "lancamentos" DROP COLUMN "descritivo_despesa_id",
DROP COLUMN "descritivo_receita_id",
DROP COLUMN "destinacao_id",
ADD COLUMN     "acao_id" TEXT,
ADD COLUMN     "despesa_id" INTEGER,
ADD COLUMN     "receita_id" INTEGER;

-- DropTable
DROP TABLE "descritivos_despesa";

-- DropTable
DROP TABLE "descritivos_receita";

-- DropTable
DROP TABLE "destinacoes";

-- DropTable
DROP TABLE "tipos_despesa";

-- DropTable
DROP TABLE "tipos_receita";

-- CreateTable
CREATE TABLE "despesas" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "cat_despesa_id" INTEGER NOT NULL,
    "cor_hex" VARCHAR(7),
    "requer_pessoa" BOOLEAN NOT NULL DEFAULT false,
    "requer_acao" BOOLEAN NOT NULL DEFAULT false,
    "requer_conta" BOOLEAN NOT NULL DEFAULT false,
    "requer_comprovante" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "despesas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receitas" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "cat_receita_id" INTEGER NOT NULL,
    "cor_hex" VARCHAR(7),
    "requer_pessoa" BOOLEAN NOT NULL DEFAULT false,
    "requer_acao" BOOLEAN NOT NULL DEFAULT false,
    "requer_conta" BOOLEAN NOT NULL DEFAULT false,
    "requer_comprovante" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receitas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cat_despesa" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "cor_hex" VARCHAR(7),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cat_despesa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cat_receita" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "cor_hex" VARCHAR(7),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cat_receita_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "despesas_nome_UNIQUE" ON "despesas"("nome");

-- CreateIndex
CREATE INDEX "despesas_cat_despesa_id" ON "despesas"("cat_despesa_id");

-- CreateIndex
CREATE UNIQUE INDEX "receitas_nome_UNIQUE" ON "receitas"("nome");

-- CreateIndex
CREATE INDEX "receitas_cat_receita_id" ON "receitas"("cat_receita_id");

-- CreateIndex
CREATE UNIQUE INDEX "cat_despesa_nome_UNIQUE" ON "cat_despesa"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "cat_receita_nome_UNIQUE" ON "cat_receita"("nome");

-- CreateIndex
CREATE INDEX "lancamentos_despesa_id" ON "lancamentos"("despesa_id");

-- CreateIndex
CREATE INDEX "lancamentos_receita_id" ON "lancamentos"("receita_id");

-- CreateIndex
CREATE INDEX "lancamentos_acao_id" ON "lancamentos"("acao_id");

-- AddForeignKey
ALTER TABLE "despesas" ADD CONSTRAINT "despesas_ibfk_1" FOREIGN KEY ("cat_despesa_id") REFERENCES "cat_despesa"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receitas" ADD CONSTRAINT "receitas_ibfk_1" FOREIGN KEY ("cat_receita_id") REFERENCES "cat_receita"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_2" FOREIGN KEY ("acao_id") REFERENCES "acoes"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_3" FOREIGN KEY ("receita_id") REFERENCES "receitas"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_4" FOREIGN KEY ("despesa_id") REFERENCES "despesas"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
