/*
  Warnings:

  - You are about to drop the column `cor_hex` on the `despesas` table. All the data in the column will be lost.
  - You are about to drop the column `cor_hex` on the `receitas` table. All the data in the column will be lost.
  - You are about to drop the `vinculos_membresia` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "membresia_tipo_evento" AS ENUM ('ADMISSAO', 'DEMISSAO', 'MUDANCA_DE_ROL');

-- CreateEnum
CREATE TYPE "membresia_rol" AS ENUM ('COMUNGANTES', 'NAO_COMUNGANTES', 'ROL_SEPARADO', 'EXCLUIDOS');

-- CreateEnum
CREATE TYPE "membresia_motivacao_evento" AS ENUM ('ADM_PROFISSAO_DE_FE', 'ADM_PROFISSAO_DE_FE_E_BATISMO', 'ADM_CARTA_DE_TRANSFERENCIA', 'ADM_JURISDICAO_A_PEDIDO', 'ADM_JURISDICAO_EX_OFFICIO', 'ADM_RESTAURACAO', 'ADM_DESIGNACAO_PRESBITERIO', 'ADM_BATISMO_NA_INFANCIA', 'ADM_TRANSFERENCIA_PAIS_OU_RESPONSAVEIS', 'ADM_JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS', 'DEM_EXCLUSAO_POR_DISCIPLINA', 'DEM_EXCLUSAO_A_PEDIDO', 'DEM_EXCLUSAO_POR_AUSENCIA', 'DEM_CARTA_DE_TRANSFERENCIA', 'DEM_JURISDICAO_ASSUMIDA', 'DEM_FALECIMENTO', 'DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS', 'DEM_DEZOITO_ANOS_COMPLETOS', 'DEM_SOLICITACAO_PAIS_OUTRA_COMUNIDADE', 'OUT_PARADEIRO_IGNORADO');

-- DropForeignKey
ALTER TABLE "vinculos_membresia" DROP CONSTRAINT "vinculos_igreja_fk";

-- DropForeignKey
ALTER TABLE "vinculos_membresia" DROP CONSTRAINT "vinculos_membresia_ibfk_1";

-- AlterTable
ALTER TABLE "despesas" DROP COLUMN "cor_hex";

-- AlterTable
ALTER TABLE "pessoas" ADD COLUMN     "conjuge_id" TEXT,
ADD COLUMN     "tratamento_id" INTEGER;

-- AlterTable
ALTER TABLE "receitas" DROP COLUMN "cor_hex";

-- DropTable
DROP TABLE "vinculos_membresia";

-- DropEnum
DROP TYPE "vinculos_membresia_forma_admissao";

-- DropEnum
DROP TYPE "vinculos_membresia_modalidade_exclusao";

-- DropEnum
DROP TYPE "vinculos_membresia_rol";

-- CreateTable
CREATE TABLE "eventos_membresia" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "tipo_evento" "membresia_tipo_evento" NOT NULL,
    "rol" "membresia_rol" NOT NULL,
    "rol_origem" "membresia_rol",
    "motivacao_evento" "membresia_motivacao_evento" NOT NULL,
    "data_evento" DATE NOT NULL,
    "igreja_origem" VARCHAR(255),
    "igreja_destino" VARCHAR(255),
    "observacoes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eventos_membresia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tratamentos" (
    "id" SERIAL NOT NULL,
    "descricao" VARCHAR(100) NOT NULL,
    "abreviacao" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tratamentos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eventos_membresia_pessoa_created" ON "eventos_membresia"("pessoa_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "eventos_membresia_igreja_id" ON "eventos_membresia"("igreja_id");

-- CreateIndex
CREATE INDEX "pessoas_tratamento_id" ON "pessoas"("tratamento_id");

-- CreateIndex
CREATE INDEX "pessoas_conjuge_id" ON "pessoas"("conjuge_id");

-- AddForeignKey
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_tratamento_fk" FOREIGN KEY ("tratamento_id") REFERENCES "tratamentos"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_conjuge_fk" FOREIGN KEY ("conjuge_id") REFERENCES "pessoas"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eventos_membresia" ADD CONSTRAINT "eventos_membresia_igreja_fk" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eventos_membresia" ADD CONSTRAINT "eventos_membresia_pessoa_fk" FOREIGN KEY ("pessoa_id") REFERENCES "pessoas"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
