BEGIN;

ALTER TABLE cargo_orgao ADD CONSTRAINT cargo_orgao_id_igreja_id_key UNIQUE (id, igreja_id);

CREATE TABLE modelo_atribuicoes (
    id TEXT PRIMARY KEY,
    igreja_id TEXT NOT NULL REFERENCES igreja(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    nome TEXT NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 100),
    nome_normalizado TEXT NOT NULL,
    acoes TEXT[] NOT NULL CHECK (cardinality(acoes) > 0),
    cargo_id TEXT,
    oficio oficio_tipo,
    CHECK ((cargo_id IS NOT NULL) <> (oficio IS NOT NULL)),
    FOREIGN KEY (cargo_id, igreja_id) REFERENCES cargo_orgao(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT modelo_atribuicoes_igreja_id_nome_normalizado_key UNIQUE (igreja_id, nome_normalizado),
    CONSTRAINT modelo_atribuicoes_id_igreja_id_key UNIQUE (id, igreja_id)
);

CREATE TABLE concessao_modelo_atuacao (
    id TEXT PRIMARY KEY,
    igreja_id TEXT NOT NULL,
    modelo_id TEXT NOT NULL,
    usuario_id TEXT NOT NULL,
    pessoa_id TEXT NOT NULL,
    geracao_vinculo INTEGER NOT NULL,
    qualificacao_id TEXT NOT NULL,
    inicio TIMESTAMPTZ(3) NOT NULL,
    fim TIMESTAMPTZ(3),
    revogado_em TIMESTAMPTZ(3),
    CHECK (fim IS NULL OR fim > inicio),
    FOREIGN KEY (modelo_id, igreja_id) REFERENCES modelo_atribuicoes(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (usuario_id, igreja_id) REFERENCES usuarios(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT concessao_modelo_atuacao_id_igreja_id_key UNIQUE (id, igreja_id)
);
CREATE INDEX concessao_modelo_atuacao_igreja_id_modelo_id_usuario_id_idx
    ON concessao_modelo_atuacao (igreja_id, modelo_id, usuario_id);

ALTER TABLE atribuicao_servico ADD COLUMN concessao_modelo_id TEXT;
ALTER TABLE atribuicao_servico ADD CONSTRAINT atribuicao_servico_concessao_modelo_id_igreja_id_fkey
    FOREIGN KEY (concessao_modelo_id, igreja_id) REFERENCES concessao_modelo_atuacao(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX atribuicao_servico_concessao_modelo_id_idx ON atribuicao_servico(concessao_modelo_id);

COMMIT;
