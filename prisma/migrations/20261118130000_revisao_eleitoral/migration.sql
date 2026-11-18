CREATE TABLE decisao_revisao_eleitoral (
 id TEXT PRIMARY KEY, igreja_id TEXT NOT NULL, pessoa_id TEXT NOT NULL, operacao VARCHAR(30) NOT NULL,
 hash_previa CHAR(64) NOT NULL, proposta JSONB NOT NULL, impacto JSONB NOT NULL,
 autoridade VARCHAR(255) NOT NULL CHECK (length(btrim(autoridade)) > 0),
 evidencia VARCHAR(1000) NOT NULL CHECK (length(btrim(evidencia)) > 0),
 justificativa VARCHAR(1000) NOT NULL CHECK (length(btrim(justificativa)) > 0),
 idempotencia UUID NOT NULL, criado_por_id TEXT NOT NULL, criado_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, aplicado_em TIMESTAMP(3),
 UNIQUE (id, igreja_id), UNIQUE (igreja_id, idempotencia),
 FOREIGN KEY (pessoa_id, igreja_id) REFERENCES pessoas(id, igreja_id) ON DELETE RESTRICT,
 FOREIGN KEY (criado_por_id, igreja_id) REFERENCES usuarios(id, igreja_id) ON DELETE RESTRICT,
 CHECK (operacao IN ('DATA', 'CONTEUDO', 'ORDEM', 'INSERCAO'))
);
CREATE INDEX decisao_revisao_eleitoral_igreja_id_pessoa_id_idx ON decisao_revisao_eleitoral(igreja_id, pessoa_id);
CREATE TABLE revisao_eleitoral_item (
 id TEXT PRIMARY KEY, igreja_id TEXT NOT NULL, decisao_id TEXT NOT NULL, conferencia_id TEXT, mandato_id TEXT, revisado_em TIMESTAMP(3),
 CHECK ((conferencia_id IS NOT NULL)::integer + (mandato_id IS NOT NULL)::integer = 1),
 UNIQUE (decisao_id, conferencia_id), UNIQUE (decisao_id, mandato_id),
 FOREIGN KEY (decisao_id, igreja_id) REFERENCES decisao_revisao_eleitoral(id, igreja_id) ON DELETE RESTRICT,
 FOREIGN KEY (conferencia_id, igreja_id) REFERENCES conferencia_eleicao_oficial(id, igreja_id) ON DELETE RESTRICT,
 FOREIGN KEY (mandato_id, igreja_id) REFERENCES mandato_oficial(id, igreja_id) ON DELETE RESTRICT
);
CREATE INDEX revisao_eleitoral_item_igreja_id_conferencia_id_revisado_em_idx ON revisao_eleitoral_item(igreja_id, conferencia_id, revisado_em);
CREATE INDEX revisao_eleitoral_item_igreja_id_mandato_id_revisado_em_idx ON revisao_eleitoral_item(igreja_id, mandato_id, revisado_em);
