-- CreateTable
CREATE TABLE "acoes" (
    "id" TEXT NOT NULL,
    "nome" VARCHAR(255) NOT NULL,
    "descricao_detalhada" TEXT,
    "cor_hex" VARCHAR(7),
    "responsavel_pessoa_id" TEXT NOT NULL,
    "conta_id" TEXT NOT NULL,
    "data_inicio" DATE NOT NULL,
    "data_fim" DATE,
    "orcamento_receita" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "orcamento_despesa" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "acoes_responsavel_pessoa_id" ON "acoes"("responsavel_pessoa_id");

-- CreateIndex
CREATE INDEX "acoes_conta_id" ON "acoes"("conta_id");

-- AddForeignKey
ALTER TABLE "acoes" ADD CONSTRAINT "acoes_ibfk_1" FOREIGN KEY ("responsavel_pessoa_id") REFERENCES "pessoas"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "acoes" ADD CONSTRAINT "acoes_ibfk_2" FOREIGN KEY ("conta_id") REFERENCES "contas"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
