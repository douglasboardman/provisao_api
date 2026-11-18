CREATE TABLE "decisao_revisao_orgao" (
  "id" TEXT NOT NULL,
  "igreja_id" TEXT NOT NULL,
  "pessoa_id" TEXT NOT NULL,
  "criado_por_id" TEXT NOT NULL,
  "operacao" VARCHAR(30) NOT NULL,
  "proposta" JSONB NOT NULL,
  "hash_previa" CHAR(64) NOT NULL,
  "hash_requisicao" CHAR(64) NOT NULL,
  "impacto" JSONB NOT NULL,
  "autoridade" VARCHAR(255) NOT NULL,
  "evidencia" VARCHAR(1000) NOT NULL,
  "justificativa" VARCHAR(1000) NOT NULL,
  "idempotencia" UUID NOT NULL,
  "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decisao_revisao_orgao_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decisao_revisao_orgao_operacao" CHECK ("operacao" IN ('DATA', 'CONTEUDO', 'ORDEM', 'INSERCAO')),
  CONSTRAINT "decisao_revisao_orgao_campos" CHECK (length(btrim("autoridade")) > 0 AND length(btrim("evidencia")) > 0 AND length(btrim("justificativa")) > 0 AND "hash_previa" ~ '^[a-f0-9]{64}$' AND "hash_requisicao" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "decisao_revisao_orgao_pessoa_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "decisao_revisao_orgao_usuario_fkey" FOREIGN KEY ("criado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "decisao_revisao_orgao_igreja_id_idempotencia_key" ON "decisao_revisao_orgao"("igreja_id", "idempotencia");
CREATE INDEX "decisao_revisao_orgao_igreja_id_pessoa_id_criado_em_idx" ON "decisao_revisao_orgao"("igreja_id", "pessoa_id", "criado_em");
