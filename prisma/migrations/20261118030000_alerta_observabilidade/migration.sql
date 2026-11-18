CREATE TABLE "execucao_alerta_oficiais" (
  "igreja_id" TEXT NOT NULL,
  "ultima_tentativa" TIMESTAMP(3) NOT NULL,
  "ultimo_sucesso" TIMESTAMP(3),
  "ultimo_erro" VARCHAR(100),
  "ultimo_total_criado" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "execucao_alerta_oficiais_pkey" PRIMARY KEY ("igreja_id"),
  CONSTRAINT "execucao_alerta_oficiais_igreja_fkey" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "execucao_alerta_total_valido" CHECK ("ultimo_total_criado" >= 0)
);
