ALTER TABLE "politica_alerta_oficiais" ADD COLUMN "dias_apos_termino" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "politica_alerta_oficiais" ADD CONSTRAINT "politica_alerta_atraso_valido" CHECK ("dias_apos_termino" BETWEEN 0 AND 365);
