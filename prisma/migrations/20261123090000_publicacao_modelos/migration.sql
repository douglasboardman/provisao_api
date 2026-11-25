BEGIN;
CREATE TABLE modelo_documento_rascunho (
  modelo_id TEXT PRIMARY KEY, igreja_id TEXT NOT NULL, contexto_id TEXT NOT NULL,
  nome VARCHAR(255) NOT NULL, tipo documento_tipo NOT NULL, finalidade VARCHAR(100) NOT NULL, configuracao JSONB NOT NULL,
  CONSTRAINT modelo_documento_rascunho_modelo_id_igreja_id_contexto_id_key UNIQUE (modelo_id, igreja_id, contexto_id),
  FOREIGN KEY (modelo_id, igreja_id, contexto_id) REFERENCES modelo_documento(id, igreja_id, contexto_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE imagem_modelo_rascunho (
  modelo_id TEXT NOT NULL, igreja_id TEXT NOT NULL, contexto_id TEXT NOT NULL, arquivo_id TEXT NOT NULL,
  PRIMARY KEY (modelo_id, arquivo_id),
  FOREIGN KEY (modelo_id, igreja_id, contexto_id) REFERENCES modelo_documento_rascunho(modelo_id, igreja_id, contexto_id) ON DELETE CASCADE ON UPDATE RESTRICT,
  FOREIGN KEY (arquivo_id, igreja_id) REFERENCES arquivo_privado(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
COMMIT;
