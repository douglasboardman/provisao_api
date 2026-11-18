-- O fim é o primeiro dia sem competência, inclusive nas revogações.
ALTER TABLE competencia_unidades DROP CONSTRAINT competencia_unidades_sem_sobreposicao;
ALTER TABLE competencia_unidades ADD CONSTRAINT competencia_unidades_sem_sobreposicao
  EXCLUDE USING gist (igreja_id WITH =, usuario_id WITH =, daterange(inicio, fim, '[)') WITH &&);
