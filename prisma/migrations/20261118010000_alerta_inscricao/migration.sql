-- Mantém avisos antigos sem presumir qual inscrição os originou.
ALTER TABLE "alerta_mandato" ADD COLUMN "inscricao_id" TEXT;
CREATE UNIQUE INDEX "inscricao_alerta_oficial_id_igreja_id_usuario_id_key" ON "inscricao_alerta_oficial"("id", "igreja_id", "usuario_id");
CREATE UNIQUE INDEX "alerta_mandato_mandato_id_inscricao_id_data_termino_key" ON "alerta_mandato"("mandato_id", "inscricao_id", "data_termino");
ALTER TABLE "alerta_mandato" ADD CONSTRAINT "alerta_mandato_inscricao_fkey" FOREIGN KEY ("inscricao_id", "igreja_id", "usuario_id") REFERENCES "inscricao_alerta_oficial"("id", "igreja_id", "usuario_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
-- O índice anterior impediria gerar novo aviso após uma inscrição revogada e refeita.
DROP INDEX "alerta_mandato_mandato_id_usuario_id_data_termino_key";
