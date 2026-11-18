-- CreateTable
CREATE TABLE "ordenacao_membresia" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "data_evento" DATE NOT NULL,
    "impacto" JSONB NOT NULL,
    "justificativa" VARCHAR(1000) NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" VARCHAR(1000) NOT NULL,
    "idempotencia" UUID NOT NULL,
    "criado_por_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ordenacao_membresia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_ordenacao_membresia" (
    "id" TEXT NOT NULL,
    "ordenacao_id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "evento_id" TEXT NOT NULL,
    "ordem_anterior" INTEGER,
    "ordem_nova" INTEGER NOT NULL,

    CONSTRAINT "item_ordenacao_membresia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ordenacao_membresia_id_igreja_id_pessoa_id_key" ON "ordenacao_membresia"("id", "igreja_id", "pessoa_id");

-- CreateIndex
CREATE UNIQUE INDEX "ordenacao_membresia_igreja_id_idempotencia_key" ON "ordenacao_membresia"("igreja_id", "idempotencia");

-- CreateIndex
CREATE UNIQUE INDEX "item_ordenacao_membresia_ordenacao_id_evento_id_key" ON "item_ordenacao_membresia"("ordenacao_id", "evento_id");

-- CreateIndex
CREATE UNIQUE INDEX "eventos_membresia_id_igreja_id_pessoa_id_key" ON "eventos_membresia"("id", "igreja_id", "pessoa_id");

-- AddForeignKey
ALTER TABLE "ordenacao_membresia" ADD CONSTRAINT "ordenacao_membresia_pessoa_id_igreja_id_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ordenacao_membresia" ADD CONSTRAINT "ordenacao_membresia_criado_por_id_igreja_id_fkey" FOREIGN KEY ("criado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "item_ordenacao_membresia" ADD CONSTRAINT "item_ordenacao_membresia_ordenacao_id_igreja_id_pessoa_id_fkey" FOREIGN KEY ("ordenacao_id", "igreja_id", "pessoa_id") REFERENCES "ordenacao_membresia"("id", "igreja_id", "pessoa_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "item_ordenacao_membresia" ADD CONSTRAINT "item_ordenacao_membresia_evento_id_igreja_id_pessoa_id_fkey" FOREIGN KEY ("evento_id", "igreja_id", "pessoa_id") REFERENCES "eventos_membresia"("id", "igreja_id", "pessoa_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ordenacao_membresia" ADD CONSTRAINT "ordenacao_membresia_dados_validos" CHECK (length(btrim("justificativa")) > 0 AND length(btrim("autoridade")) > 0 AND length(btrim("evidencia")) > 0);
ALTER TABLE "item_ordenacao_membresia" ADD CONSTRAINT "item_ordenacao_ordens_validas" CHECK (("ordem_anterior" IS NULL OR "ordem_anterior" > 0) AND "ordem_nova" > 0);
