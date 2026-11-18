-- Associação explícita, sem inferir correspondências de contas existentes.
ALTER TABLE "usuarios" ADD COLUMN "pessoa_id" TEXT;
CREATE UNIQUE INDEX "pessoas_id_igreja_id_key" ON "pessoas"("id", "igreja_id");
CREATE UNIQUE INDEX "usuarios_pessoa_id_key" ON "usuarios"("pessoa_id");
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_pessoa_igreja_fkey"
  FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
