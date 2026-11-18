CREATE TABLE insercao_retroativa_oficial (
  id TEXT PRIMARY KEY, igreja_id TEXT NOT NULL, oficial_id TEXT NOT NULL, evento_id TEXT NOT NULL UNIQUE,
  impacto JSONB NOT NULL, justificativa VARCHAR(1000) NOT NULL CHECK (length(btrim(justificativa)) > 0),
  idempotencia UUID NOT NULL, criado_por_id TEXT NOT NULL, criado_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (igreja_id, idempotencia), UNIQUE (evento_id, igreja_id, oficial_id),
  FOREIGN KEY (oficial_id, igreja_id) REFERENCES oficial(id, igreja_id) ON DELETE RESTRICT,
  FOREIGN KEY (evento_id, igreja_id, oficial_id) REFERENCES evento_oficial(id, igreja_id, oficial_id) ON DELETE RESTRICT,
  FOREIGN KEY (criado_por_id, igreja_id) REFERENCES usuarios(id, igreja_id) ON DELETE RESTRICT
);
CREATE INDEX insercao_retroativa_oficial_igreja_id_oficial_id_idx ON insercao_retroativa_oficial(igreja_id, oficial_id);
