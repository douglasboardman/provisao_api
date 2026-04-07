/*
  Warnings:

  - The values [POUPANÇA] on the enum `tipo_conta` will be removed. If these variants are still used in the database, this will fail.
  - The `estado` column on the `pessoas` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[igreja_id,nome]` on the table `cat_despesa` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[igreja_id,nome]` on the table `cat_receita` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[igreja_id,nome]` on the table `despesas` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[igreja_id,cpf]` on the table `pessoas` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[igreja_id,email]` on the table `pessoas` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[igreja_id,nome]` on the table `receitas` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[igreja_id,email_login]` on the table `usuarios` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `igreja_id` to the `acoes` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `cat_despesa` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `cat_receita` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `contas` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `despesas` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `grupos_familiares` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `lancamentos` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `logs_atividades` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `pessoas` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `receitas` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `usuarios` table without a default value. This is not possible if the table is not empty.
  - Added the required column `igreja_id` to the `vinculos_membresia` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "estados_brasil" AS ENUM ('AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO');

-- AlterEnum
BEGIN;
CREATE TYPE "tipo_conta_new" AS ENUM ('CORRENTE', 'POUPANCA', 'INVESTIMENTO', 'CAIXA');
ALTER TABLE "contas" ALTER COLUMN "tipo_conta" TYPE "tipo_conta_new" USING ("tipo_conta"::text::"tipo_conta_new");
ALTER TYPE "tipo_conta" RENAME TO "tipo_conta_old";
ALTER TYPE "tipo_conta_new" RENAME TO "tipo_conta";
DROP TYPE "tipo_conta_old";
COMMIT;

-- DropIndex
DROP INDEX "cat_despesa_nome_UNIQUE";

-- DropIndex
DROP INDEX "cat_receita_nome_UNIQUE";

-- DropIndex
DROP INDEX "despesas_nome_UNIQUE";

-- DropIndex
DROP INDEX "pessoas_cpf_UNIQUE";

-- DropIndex
DROP INDEX "pessoas_email_UNIQUE";

-- DropIndex
DROP INDEX "receitas_nome_UNIQUE";

-- DropIndex
DROP INDEX "usuarios_email_login_UNIQUE";

-- DropIndex
DROP INDEX "usuarios_nome_usuario_UNIQUE";

-- AlterTable
ALTER TABLE "acoes" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "cat_despesa" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "cat_receita" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "contas" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "despesas" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "grupos_familiares" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "lancamentos" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "logs_atividades" ADD COLUMN     "igreja_id" TEXT NOT NULL,
ALTER COLUMN "registro_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "pessoas" ADD COLUMN     "igreja_id" TEXT NOT NULL,
DROP COLUMN "estado",
ADD COLUMN     "estado" "estados_brasil";

-- AlterTable
ALTER TABLE "receitas" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "vinculos_membresia" ADD COLUMN     "igreja_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "igreja" (
    "id" TEXT NOT NULL,
    "cnpj" VARCHAR(14),
    "nome" VARCHAR(255) NOT NULL,
    "url_logo" VARCHAR(255),
    "congregacao" BOOLEAN NOT NULL DEFAULT false,
    "vinculada_a" TEXT,
    "cep" VARCHAR(8),
    "logradouro" VARCHAR(255),
    "numero" VARCHAR(20),
    "complemento" VARCHAR(100),
    "bairro" VARCHAR(100),
    "cidade" VARCHAR(100),
    "estado" "estados_brasil",
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "igreja_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "igreja_cnpj_UNIQUE" ON "igreja"("cnpj");

-- CreateIndex
CREATE INDEX "igreja_vinculada_a_idx" ON "igreja"("vinculada_a");

-- CreateIndex
CREATE INDEX "acoes_igreja_id" ON "acoes"("igreja_id");

-- CreateIndex
CREATE INDEX "cat_despesa_igreja_id" ON "cat_despesa"("igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "cat_despesa_igreja_nome_UNIQUE" ON "cat_despesa"("igreja_id", "nome");

-- CreateIndex
CREATE INDEX "cat_receita_igreja_id" ON "cat_receita"("igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "cat_receita_igreja_nome_UNIQUE" ON "cat_receita"("igreja_id", "nome");

-- CreateIndex
CREATE INDEX "contas_igreja_id" ON "contas"("igreja_id");

-- CreateIndex
CREATE INDEX "despesas_igreja_id" ON "despesas"("igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "despesas_igreja_nome_UNIQUE" ON "despesas"("igreja_id", "nome");

-- CreateIndex
CREATE INDEX "grupos_familiares_igreja_id" ON "grupos_familiares"("igreja_id");

-- CreateIndex
CREATE INDEX "lancamentos_igreja_id" ON "lancamentos"("igreja_id");

-- CreateIndex
CREATE INDEX "logs_atividades_igreja_id" ON "logs_atividades"("igreja_id");

-- CreateIndex
CREATE INDEX "pessoas_igreja_id" ON "pessoas"("igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "pessoas_igreja_cpf_UNIQUE" ON "pessoas"("igreja_id", "cpf");

-- CreateIndex
CREATE UNIQUE INDEX "pessoas_igreja_email_UNIQUE" ON "pessoas"("igreja_id", "email");

-- CreateIndex
CREATE INDEX "receitas_igreja_id" ON "receitas"("igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "receitas_igreja_nome_UNIQUE" ON "receitas"("igreja_id", "nome");

-- CreateIndex
CREATE INDEX "usuarios_igreja_id" ON "usuarios"("igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_igreja_email_UNIQUE" ON "usuarios"("igreja_id", "email_login");

-- CreateIndex
CREATE INDEX "vinculos_membresia_igreja_id" ON "vinculos_membresia"("igreja_id");

-- AddForeignKey
ALTER TABLE "igreja" ADD CONSTRAINT "igreja_matriz_fk" FOREIGN KEY ("vinculada_a") REFERENCES "igreja"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "acoes" ADD CONSTRAINT "acoes_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contas" ADD CONSTRAINT "contas_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "despesas" ADD CONSTRAINT "despesas_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receitas" ADD CONSTRAINT "receitas_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "grupos_familiares" ADD CONSTRAINT "grupos_familiares_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "logs_atividades" ADD CONSTRAINT "logs_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cat_despesa" ADD CONSTRAINT "cat_despesa_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cat_receita" ADD CONSTRAINT "cat_receita_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vinculos_membresia" ADD CONSTRAINT "vinculos_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
