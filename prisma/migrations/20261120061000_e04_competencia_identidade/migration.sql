-- A competência pertence à pessoa comprovada, além da conta que a opera.
-- Na instalação nova, a tabela criada pela E04 ainda estará vazia.
ALTER TABLE competencia_secretaria ADD COLUMN pessoa_id TEXT;
UPDATE competencia_secretaria c SET pessoa_id = u.pessoa_id
  FROM usuarios u WHERE u.id = c.usuario_id AND u.igreja_id = c.igreja_id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM competencia_secretaria WHERE pessoa_id IS NULL) THEN
    RAISE EXCEPTION 'Competência sem pessoa comprovada exige conferência antes da migração';
  END IF;
END $$;
ALTER TABLE competencia_secretaria ALTER COLUMN pessoa_id SET NOT NULL;
ALTER TABLE competencia_secretaria ADD CONSTRAINT competencia_secretaria_pessoa_id_igreja_id_fkey
  FOREIGN KEY (pessoa_id, igreja_id) REFERENCES pessoas(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
