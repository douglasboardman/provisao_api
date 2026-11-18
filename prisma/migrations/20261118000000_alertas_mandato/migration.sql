-- CreateTable
CREATE TABLE "politica_alerta_oficiais" (
    "igreja_id" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT false,
    "dias_antecedencia" INTEGER NOT NULL,
    "fuso_iana" VARCHAR(100) NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "fundamento" VARCHAR(1000) NOT NULL,
    "alterado_por_id" TEXT NOT NULL,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "politica_alerta_oficiais_pkey" PRIMARY KEY ("igreja_id")
);

-- CreateTable
CREATE TABLE "inscricao_alerta_oficial" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "criado_por_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revogado_em" TIMESTAMP(3),

    CONSTRAINT "inscricao_alerta_oficial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerta_mandato" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "mandato_id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "data_termino" DATE NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lido_em" TIMESTAMP(3),

    CONSTRAINT "alerta_mandato_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inscricao_alerta_oficial_igreja_id_usuario_id_idx" ON "inscricao_alerta_oficial"("igreja_id", "usuario_id");

-- CreateIndex
CREATE INDEX "alerta_mandato_igreja_id_usuario_id_criado_em_idx" ON "alerta_mandato"("igreja_id", "usuario_id", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "alerta_mandato_mandato_id_usuario_id_data_termino_key" ON "alerta_mandato"("mandato_id", "usuario_id", "data_termino");

-- CreateIndex
CREATE UNIQUE INDEX "mandato_oficial_id_igreja_id_key" ON "mandato_oficial"("id", "igreja_id");

-- AddForeignKey
ALTER TABLE "politica_alerta_oficiais" ADD CONSTRAINT "politica_alerta_oficiais_igreja_id_fkey" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "politica_alerta_oficiais" ADD CONSTRAINT "politica_alerta_oficiais_alterado_por_id_igreja_id_fkey" FOREIGN KEY ("alterado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inscricao_alerta_oficial" ADD CONSTRAINT "inscricao_alerta_oficial_usuario_id_igreja_id_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inscricao_alerta_oficial" ADD CONSTRAINT "inscricao_alerta_oficial_criado_por_id_igreja_id_fkey" FOREIGN KEY ("criado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerta_mandato" ADD CONSTRAINT "alerta_mandato_mandato_id_igreja_id_fkey" FOREIGN KEY ("mandato_id", "igreja_id") REFERENCES "mandato_oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerta_mandato" ADD CONSTRAINT "alerta_mandato_usuario_id_igreja_id_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "inscricao_alerta_ativa_unica" ON "inscricao_alerta_oficial" ("igreja_id", "usuario_id") WHERE "revogado_em" IS NULL;
ALTER TABLE "politica_alerta_oficiais" ADD CONSTRAINT "politica_alerta_campos_validos" CHECK (
 "dias_antecedencia" BETWEEN 1 AND 365 AND length(btrim("fuso_iana")) > 0 AND length(btrim("autoridade")) > 0 AND length(btrim("fundamento")) > 0
);
