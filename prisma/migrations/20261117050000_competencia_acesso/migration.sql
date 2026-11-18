CREATE TABLE "competencia_acesso" (
  "id" TEXT NOT NULL, "igreja_id" TEXT NOT NULL, "usuario_id" TEXT NOT NULL, "pessoa_id" TEXT NOT NULL,
  "referencia" VARCHAR(500) NOT NULL, "concedido_por" TEXT NOT NULL, "concedido_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revogado_por" TEXT, "revogado_em" TIMESTAMP(3),
  CONSTRAINT "competencia_acesso_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "competencia_acesso_usuario_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "competencia_acesso_pessoa_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "competencia_acesso_concedente_fkey" FOREIGN KEY ("concedido_por", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "competencia_acesso_revogador_fkey" FOREIGN KEY ("revogado_por", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "competencia_acesso_revogacao_check" CHECK (("revogado_em" IS NULL) = ("revogado_por" IS NULL))
);
CREATE UNIQUE INDEX "competencia_acesso_vigente_key" ON "competencia_acesso"("igreja_id", "usuario_id") WHERE "revogado_em" IS NULL;
CREATE INDEX "competencia_acesso_igreja_usuario_idx" ON "competencia_acesso"("igreja_id", "usuario_id");
