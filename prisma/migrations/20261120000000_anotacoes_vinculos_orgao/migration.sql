ALTER TABLE "decisao_revisao_orgao" ADD COLUMN "anotacoes_vinculos" JSONB;
ALTER TABLE "decisao_revisao_orgao" ADD CONSTRAINT "decisao_revisao_orgao_anotacoes_array" CHECK ("anotacoes_vinculos" IS NULL OR jsonb_typeof("anotacoes_vinculos") = 'array');
