-- CreateEnum
CREATE TYPE "tipo_regra_enum" AS ENUM ('FILTRO', 'MAPEAMENTO');

-- CreateTable
CREATE TABLE "regras_relacao_enum" (
    "id" TEXT NOT NULL,
    "modulo" VARCHAR(100) NOT NULL,
    "nome" VARCHAR(255) NOT NULL,
    "descricao" TEXT,
    "tipo_regra" "tipo_regra_enum" NOT NULL,
    "enum_classificador" VARCHAR(100) NOT NULL,
    "enum_classificado" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regras_relacao_enum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relacao_enum_valores" (
    "id" TEXT NOT NULL,
    "regra_id" TEXT NOT NULL,
    "valor_classificador" VARCHAR(100) NOT NULL,
    "valor_classificado" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relacao_enum_valores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "regras_relacao_enum_modulo_nome_key" ON "regras_relacao_enum"("modulo", "nome");

-- CreateIndex
CREATE INDEX "relacao_enum_valores_regra_id_idx" ON "relacao_enum_valores"("regra_id");

-- CreateIndex
CREATE UNIQUE INDEX "relacao_enum_valores_regra_id_valor_classificador_valor_cla_key" ON "relacao_enum_valores"("regra_id", "valor_classificador", "valor_classificado");

-- AddForeignKey
ALTER TABLE "relacao_enum_valores" ADD CONSTRAINT "relacao_enum_valores_regra_id_fkey" FOREIGN KEY ("regra_id") REFERENCES "regras_relacao_enum"("id") ON DELETE CASCADE ON UPDATE CASCADE;
