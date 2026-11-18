ALTER TABLE "decisao_revisao_orgao" ADD COLUMN "resultado" VARCHAR(30);
ALTER TABLE "decisao_revisao_orgao" ADD CONSTRAINT "decisao_revisao_orgao_resultado_check" CHECK ("resultado" IS NULL OR "resultado" IN ('FAVORAVEL', 'DESFAVORAVEL'));
