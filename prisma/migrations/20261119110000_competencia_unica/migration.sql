-- A revogação não pode deixar outra competência simultânea para o mesmo titular.
ALTER TABLE "competencia_unidades" ADD CONSTRAINT "competencia_unidades_sem_sobreposicao"
  EXCLUDE USING gist ("igreja_id" WITH =, "usuario_id" WITH =, daterange("inicio", "fim", '[]') WITH &&);

-- O fim da presidência é a primeira data sem autoridade; possibilita sucessão no dia.
ALTER TABLE "presidencia_conselho" DROP CONSTRAINT "presidencia_periodo_valido";
ALTER TABLE "presidencia_conselho" DROP CONSTRAINT "presidencia_sem_sobreposicao";
ALTER TABLE "presidencia_conselho" ADD CONSTRAINT "presidencia_periodo_valido" CHECK ("fim" IS NULL OR "fim" > "inicio");
ALTER TABLE "presidencia_conselho" ADD CONSTRAINT "presidencia_sem_sobreposicao" EXCLUDE USING gist ("igreja_id" WITH =, daterange("inicio", "fim", '[)') WITH &&);
