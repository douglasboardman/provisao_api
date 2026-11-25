-- As competências legadas mantêm a origem. Cada migração para conta comum
-- vincula as competências conferidas à nova geração da identidade.
ALTER TABLE competencia_secretaria ADD COLUMN geracao_vinculo integer;
