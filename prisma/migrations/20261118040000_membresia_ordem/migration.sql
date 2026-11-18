-- Dados antigos permanecem sem ordem até conferência; nunca se infere ordem por criação ou UUID.
ALTER TABLE "eventos_membresia" ADD COLUMN "ordem_dia" INTEGER;
ALTER TABLE "eventos_membresia" ADD CONSTRAINT "membresia_ordem_positiva" CHECK ("ordem_dia" IS NULL OR "ordem_dia" > 0);
CREATE UNIQUE INDEX "membresia_ordem_unica" ON "eventos_membresia" ("igreja_id", "pessoa_id", "data_evento", "ordem_dia") WHERE "ordem_dia" IS NOT NULL;
