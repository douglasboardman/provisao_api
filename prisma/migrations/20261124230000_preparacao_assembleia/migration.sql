BEGIN;
-- AlterTable
ALTER TABLE "competencia_secretaria" ADD COLUMN     "pode_instalar_mesa" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "reuniao" ADD COLUMN     "instalacao_formal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "deliberacao_ata" ADD COLUMN     "mesa_id" TEXT;

-- CreateTable
CREATE TABLE "folha_presenca_assembleia" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "reuniao_id" TEXT NOT NULL,
    "versao" INTEGER NOT NULL,
    "referencia" DATE NOT NULL,
    "extraida_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extraida_por" TEXT NOT NULL,
    "identificacao" TEXT NOT NULL,
    "linhas" JSONB NOT NULL,

    CONSTRAINT "folha_presenca_assembleia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mesa_assembleia" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "reuniao_id" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "presidente_oficial_id" TEXT NOT NULL,
    "secretario_id" TEXT NOT NULL,
    "presidente_nome" TEXT NOT NULL,
    "secretario_nome" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "fundamento" TEXT NOT NULL,
    "vigente_desde" TIMESTAMPTZ(3) NOT NULL,
    "registrada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrada_por" TEXT NOT NULL,

    CONSTRAINT "mesa_assembleia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "folha_presenca_assembleia_reuniao_id_versao_key" ON "folha_presenca_assembleia"("reuniao_id", "versao");

-- CreateIndex
CREATE UNIQUE INDEX "mesa_assembleia_id_reuniao_id_igreja_id_contexto_id_key" ON "mesa_assembleia"("id", "reuniao_id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "mesa_assembleia_reuniao_id_ordem_key" ON "mesa_assembleia"("reuniao_id", "ordem");

-- AddForeignKey
ALTER TABLE "deliberacao_ata" ADD CONSTRAINT "deliberacao_ata_mesa_id_reuniao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("mesa_id", "reuniao_id", "igreja_id", "contexto_id") REFERENCES "mesa_assembleia"("id", "reuniao_id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "folha_presenca_assembleia" ADD CONSTRAINT "folha_presenca_assembleia_reuniao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("reuniao_id", "igreja_id", "contexto_id") REFERENCES "reuniao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "folha_presenca_assembleia" ADD CONSTRAINT "folha_presenca_assembleia_extraida_por_igreja_id_fkey" FOREIGN KEY ("extraida_por", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mesa_assembleia" ADD CONSTRAINT "mesa_assembleia_presidente_oficial_id_igreja_id_fkey" FOREIGN KEY ("presidente_oficial_id", "igreja_id") REFERENCES "oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mesa_assembleia" ADD CONSTRAINT "mesa_assembleia_secretario_id_igreja_id_fkey" FOREIGN KEY ("secretario_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mesa_assembleia" ADD CONSTRAINT "mesa_assembleia_registrada_por_igreja_id_fkey" FOREIGN KEY ("registrada_por", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mesa_assembleia" ADD CONSTRAINT "mesa_assembleia_reuniao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("reuniao_id", "igreja_id", "contexto_id") REFERENCES "reuniao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

UPDATE reuniao SET instalacao_formal = true WHERE modalidade IN ('AGO','AGE') AND dados->>'situacao' = 'AGENDADA';
CREATE FUNCTION preservar_registro_assembleia() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A folha ou composição já registrada é imutável.' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER folha_preservada BEFORE UPDATE OR DELETE ON folha_presenca_assembleia FOR EACH ROW EXECUTE FUNCTION preservar_registro_assembleia();
CREATE TRIGGER mesa_preservada BEFORE UPDATE OR DELETE ON mesa_assembleia FOR EACH ROW EXECUTE FUNCTION preservar_registro_assembleia();
COMMIT;
