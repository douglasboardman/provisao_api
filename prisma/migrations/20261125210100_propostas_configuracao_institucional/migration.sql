CREATE TABLE proposta_versao_orgao (
  id text PRIMARY KEY,
  igreja_id text NOT NULL,
  orgao_id text NOT NULL,
  base_id text NOT NULL,
  operador_id text NOT NULL,
  entrada jsonb NOT NULL,
  alteracoes jsonb NOT NULL,
  previa char(64) NOT NULL CHECK (previa ~ '^[0-9a-f]{64}$'),
  atualizado_em timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT proposta_versao_orgao_igreja_id_orgao_id_key UNIQUE (igreja_id, orgao_id),
  CONSTRAINT proposta_versao_orgao_orgao_fk FOREIGN KEY (orgao_id, igreja_id) REFERENCES orgao_interno(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT proposta_versao_orgao_base_fk FOREIGN KEY (base_id, igreja_id, orgao_id) REFERENCES versao_orgao(id, igreja_id, orgao_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT proposta_versao_orgao_operador_fk FOREIGN KEY (operador_id, igreja_id) REFERENCES usuarios(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
