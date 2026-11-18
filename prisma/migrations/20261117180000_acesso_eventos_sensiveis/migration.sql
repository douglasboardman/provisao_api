-- CreateTable
CREATE TABLE "acesso_eventos_sensiveis" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "concedido_por_id" TEXT NOT NULL,
    "concedido_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pode_consultar" BOOLEAN NOT NULL,
    "pode_registrar" BOOLEAN NOT NULL,
    "fundamento" VARCHAR(1000) NOT NULL,
    "revogado_em" TIMESTAMP(3),
    "revogado_por_id" TEXT,
    "motivo_revogacao" VARCHAR(1000),

    CONSTRAINT "acesso_eventos_sensiveis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "acesso_eventos_sensiveis_igreja_id_usuario_id_idx" ON "acesso_eventos_sensiveis"("igreja_id", "usuario_id");

-- AddForeignKey
ALTER TABLE "acesso_eventos_sensiveis" ADD CONSTRAINT "acesso_eventos_sensiveis_usuario_id_igreja_id_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "acesso_eventos_sensiveis" ADD CONSTRAINT "acesso_eventos_sensiveis_concedido_por_id_igreja_id_fkey" FOREIGN KEY ("concedido_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "acesso_eventos_sensiveis" ADD CONSTRAINT "acesso_eventos_sensiveis_revogado_por_id_igreja_id_fkey" FOREIGN KEY ("revogado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "acesso_sensivel_ativo_unico" ON "acesso_eventos_sensiveis" ("igreja_id", "usuario_id") WHERE "revogado_em" IS NULL;
ALTER TABLE "acesso_eventos_sensiveis" ADD CONSTRAINT "acesso_sensivel_dados_validos" CHECK (
  ("pode_consultar" OR "pode_registrar") AND "usuario_id" <> "concedido_por_id" AND length(btrim("fundamento")) > 0
  AND (("revogado_em" IS NULL AND "revogado_por_id" IS NULL AND "motivo_revogacao" IS NULL) OR
       ("revogado_em" IS NOT NULL AND "revogado_por_id" IS NOT NULL AND "motivo_revogacao" IS NOT NULL AND length(btrim("motivo_revogacao")) > 0))
);
