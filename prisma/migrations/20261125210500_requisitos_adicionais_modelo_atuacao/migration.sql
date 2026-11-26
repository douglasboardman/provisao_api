BEGIN;

-- O primeiro requisito permanece no perfil para preservar as concessões e a leitura pela versão anterior.
CREATE TABLE requisito_adicional_modelo_atuacao (
    modelo_id TEXT NOT NULL,
    igreja_id TEXT NOT NULL,
    ordem INTEGER NOT NULL CHECK (ordem > 0),
    cargo_id TEXT,
    oficio oficio_tipo,
    CHECK ((cargo_id IS NOT NULL) <> (oficio IS NOT NULL)),
    PRIMARY KEY (modelo_id, ordem),
    UNIQUE (modelo_id, cargo_id),
    UNIQUE (modelo_id, oficio),
    FOREIGN KEY (modelo_id, igreja_id) REFERENCES modelo_atribuicoes(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (cargo_id, igreja_id) REFERENCES cargo_orgao(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

COMMIT;
