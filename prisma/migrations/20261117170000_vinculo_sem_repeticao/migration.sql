-- Repetir o mesmo ato não deve criar dois vínculos para o mesmo oficial.
CREATE UNIQUE INDEX "vinculo_pastoral_ato_unico" ON "vinculo_pastoral" ("oficial_id", "modalidade", "concilio", "ato", "data_inicio");
