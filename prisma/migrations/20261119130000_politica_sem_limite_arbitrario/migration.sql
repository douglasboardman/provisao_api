ALTER TABLE "politica_unidade" DROP CONSTRAINT "politica_unidade_campos_validos";
ALTER TABLE "politica_unidade" ADD CONSTRAINT "politica_unidade_campos_validos" CHECK (
  "inicio" <= "fim" AND "prazo_maximo_meses" > 0 AND
  length(trim("versao")) > 0 AND length(trim("fonte")) > 0 AND length(trim("autoridade")) > 0 AND length(trim("evidencia")) > 0
);
