-- CreateTable
CREATE TABLE "requisicao_institucional" (
    "igreja_id" TEXT NOT NULL,
    "idempotencia" VARCHAR(36) NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "tipo" VARCHAR(80) NOT NULL,
    "hash_requisicao" CHAR(64) NOT NULL,
    "resultado" JSONB NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requisicao_institucional_pkey" PRIMARY KEY ("igreja_id","idempotencia")
);

-- AddForeignKey
ALTER TABLE "requisicao_institucional" ADD CONSTRAINT "requisicao_institucional_usuario_id_igreja_id_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "requisicao_institucional" ADD CONSTRAINT "requisicao_institucional_chave_valida" CHECK (
  "idempotencia" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
  "hash_requisicao" ~ '^[0-9a-f]{64}$' AND length(trim("tipo")) > 0
);

