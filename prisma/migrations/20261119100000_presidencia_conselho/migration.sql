-- CreateTable
CREATE TABLE "presidencia_conselho" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "oficial_id" TEXT NOT NULL,
    "inicio" DATE NOT NULL,
    "fim" DATE,
    "evidencia" TEXT NOT NULL,
    "registrado_por" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "presidencia_conselho_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "presidencia_conselho_igreja_id_oficial_id_inicio_idx" ON "presidencia_conselho"("igreja_id", "oficial_id", "inicio");

-- AddForeignKey
ALTER TABLE "presidencia_conselho" ADD CONSTRAINT "presidencia_conselho_oficial_id_igreja_id_fkey" FOREIGN KEY ("oficial_id", "igreja_id") REFERENCES "oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "presidencia_conselho" ADD CONSTRAINT "presidencia_conselho_registrado_por_igreja_id_fkey" FOREIGN KEY ("registrado_por", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "presidencia_conselho" ADD CONSTRAINT "presidencia_periodo_valido" CHECK ("fim" IS NULL OR "fim" >= "inicio");
ALTER TABLE "presidencia_conselho" ADD CONSTRAINT "presidencia_evidencia_obrigatoria" CHECK (length(trim("evidencia")) > 0);
ALTER TABLE "presidencia_conselho" ADD CONSTRAINT "presidencia_sem_sobreposicao" EXCLUDE USING gist ("igreja_id" WITH =, daterange("inicio", "fim", '[]') WITH &&);

