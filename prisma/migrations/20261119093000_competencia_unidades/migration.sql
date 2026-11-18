-- CreateTable
CREATE TABLE "competencia_unidades" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "registrado_por" TEXT NOT NULL,
    "inicio" DATE NOT NULL,
    "fim" DATE,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competencia_unidades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competencia_unidades_igreja_id_usuario_id_inicio_idx" ON "competencia_unidades"("igreja_id", "usuario_id", "inicio");

-- AddForeignKey
ALTER TABLE "competencia_unidades" ADD CONSTRAINT "competencia_unidades_usuario_id_igreja_id_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "competencia_unidades" ADD CONSTRAINT "competencia_unidades_pessoa_id_igreja_id_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "competencia_unidades" ADD CONSTRAINT "competencia_unidades_registrado_por_igreja_id_fkey" FOREIGN KEY ("registrado_por", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "competencia_unidades" ADD CONSTRAINT "competencia_unidades_periodo_valido" CHECK ("fim" IS NULL OR "fim" >= "inicio");
ALTER TABLE "competencia_unidades" ADD CONSTRAINT "competencia_unidades_evidencia_obrigatoria" CHECK (length(trim("autoridade")) > 0 AND length(trim("evidencia")) > 0);

