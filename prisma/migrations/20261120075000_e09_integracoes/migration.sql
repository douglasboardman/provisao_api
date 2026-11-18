CREATE UNIQUE INDEX "acoes_id_igreja_id_key" ON acoes(id, igreja_id);
CREATE UNIQUE INDEX "contas_id_igreja_id_key" ON contas(id, igreja_id);
CREATE UNIQUE INDEX "ato_orgao_id_igreja_id_key" ON ato_orgao(id, igreja_id);
CREATE UNIQUE INDEX "documento_versao_id_igreja_id_documento_id_key" ON documento_versao(id, igreja_id, documento_id);

ALTER TABLE referencia_ata_membresia ADD COLUMN ata_documento_id TEXT;
ALTER TABLE referencia_ata_oficial ADD COLUMN ata_documento_id TEXT;
UPDATE referencia_ata_membresia r SET ata_documento_id = v.documento_id FROM documento_versao v WHERE v.id = r.versao_id;
UPDATE referencia_ata_oficial r SET ata_documento_id = v.documento_id FROM documento_versao v WHERE v.id = r.versao_id;
ALTER TABLE referencia_ata_membresia DROP CONSTRAINT referencia_ata_membresia_versao_fkey,
  ADD CONSTRAINT referencia_ata_membresia_ata_fkey FOREIGN KEY (versao_id, igreja_id, ata_documento_id) REFERENCES documento_versao(id, igreja_id, documento_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT referencia_membresia_par_check CHECK ((versao_id IS NULL) = (ata_documento_id IS NULL) AND sequencia > 0);
ALTER TABLE referencia_ata_oficial DROP CONSTRAINT referencia_oficial_versao_fkey,
  ADD CONSTRAINT referencia_ata_oficial_ata_fkey FOREIGN KEY (versao_id, igreja_id, ata_documento_id) REFERENCES documento_versao(id, igreja_id, documento_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT referencia_oficial_par_check CHECK ((versao_id IS NULL) = (ata_documento_id IS NULL) AND sequencia > 0);

CREATE TABLE autorizacao_financeira_documental (
  id TEXT PRIMARY KEY, igreja_id TEXT NOT NULL, projeto_id TEXT, conta_id TEXT,
  tipo VARCHAR(40) NOT NULL, assunto VARCHAR(255) NOT NULL, data_decisao DATE NOT NULL,
  autoridade VARCHAR(255) NOT NULL, evidencia TEXT NOT NULL, registrado_por_id TEXT NOT NULL,
  criado_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "autorizacao_financeira_documental_projeto_id_igreja_id_fkey" FOREIGN KEY (projeto_id, igreja_id) REFERENCES acoes(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "autorizacao_financeira_documental_conta_id_igreja_id_fkey" FOREIGN KEY (conta_id, igreja_id) REFERENCES contas(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "autorizacao_financeira_registrador_fkey" FOREIGN KEY (registrado_por_id, igreja_id) REFERENCES usuarios(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "autorizacao_financeira_documental_id_igreja_id_key" ON autorizacao_financeira_documental(id, igreja_id);
CREATE INDEX "autorizacao_financeira_documental_igreja_id_projeto_id_idx" ON autorizacao_financeira_documental(igreja_id, projeto_id);
CREATE INDEX "autorizacao_financeira_documental_igreja_id_conta_id_idx" ON autorizacao_financeira_documental(igreja_id, conta_id);

CREATE TABLE referencia_ata_institucional (
  id TEXT PRIMARY KEY, igreja_id TEXT NOT NULL, ato_orgao_id TEXT, autorizacao_id TEXT,
  etapa VARCHAR(20) NOT NULL, ata_documento_id TEXT, versao_id TEXT, referencia_externa JSONB,
  justificativa TEXT NOT NULL, sequencia INTEGER NOT NULL, registrado_por_id TEXT NOT NULL,
  criado_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referencia_institucional_alvo_check CHECK (
    (ato_orgao_id IS NOT NULL AND autorizacao_id IS NULL AND etapa IN ('ATO','ELEICAO','POSSE'))
    OR (ato_orgao_id IS NULL AND autorizacao_id IS NOT NULL AND etapa = 'ATO')),
  CONSTRAINT referencia_institucional_fonte_check CHECK (
    (versao_id IS NULL) = (ata_documento_id IS NULL) AND (versao_id IS NULL OR referencia_externa IS NULL) AND sequencia > 0),
  CONSTRAINT "referencia_ata_institucional_ato_orgao_id_igreja_id_fkey" FOREIGN KEY (ato_orgao_id, igreja_id) REFERENCES ato_orgao(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "referencia_ata_institucional_autorizacao_id_igreja_id_fkey" FOREIGN KEY (autorizacao_id, igreja_id) REFERENCES autorizacao_financeira_documental(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "referencia_institucional_ata_fkey" FOREIGN KEY (versao_id, igreja_id, ata_documento_id) REFERENCES documento_versao(id, igreja_id, documento_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "referencia_ata_institucional_registrado_por_id_igreja_id_fkey" FOREIGN KEY (registrado_por_id, igreja_id) REFERENCES usuarios(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "referencia_institucional_orgao_seq_key" ON referencia_ata_institucional(igreja_id, ato_orgao_id, etapa, sequencia);
CREATE UNIQUE INDEX "referencia_institucional_financeira_seq_key" ON referencia_ata_institucional(igreja_id, autorizacao_id, etapa, sequencia);
CREATE INDEX "referencia_ata_institucional_igreja_id_ata_documento_id_idx" ON referencia_ata_institucional(igreja_id, ata_documento_id);

CREATE FUNCTION e09_preservar_referencia() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Preserve o registro original e acrescente uma correção documental' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER e09_historico_membresia BEFORE UPDATE OR DELETE ON referencia_ata_membresia
  FOR EACH ROW EXECUTE FUNCTION e09_preservar_referencia();
CREATE TRIGGER e09_historico_oficial BEFORE UPDATE OR DELETE ON referencia_ata_oficial
  FOR EACH ROW EXECUTE FUNCTION e09_preservar_referencia();
CREATE TRIGGER e09_historico_institucional BEFORE UPDATE OR DELETE ON referencia_ata_institucional
  FOR EACH ROW EXECUTE FUNCTION e09_preservar_referencia();
CREATE TRIGGER e09_historico_autorizacao BEFORE UPDATE OR DELETE ON autorizacao_financeira_documental
  FOR EACH ROW EXECUTE FUNCTION e09_preservar_referencia();

CREATE VIEW e09_referencia AS
  SELECT igreja_id, 'MEMBRESIA'::text AS grupo, evento_id AS alvo_id, 'ATO'::text AS etapa,
    id, ata_documento_id, versao_id, referencia_externa, justificativa, sequencia, registrado_por_id, criado_em
  FROM referencia_ata_membresia
  UNION ALL
  SELECT igreja_id, CASE WHEN mandato_id IS NOT NULL THEN 'MANDATO' ELSE 'PASTORAL' END,
    coalesce(mandato_id, vinculo_id), ato, id, ata_documento_id, versao_id, referencia_externa, justificativa, sequencia, registrado_por_id, criado_em
  FROM referencia_ata_oficial
  UNION ALL
  SELECT igreja_id, CASE WHEN ato_orgao_id IS NOT NULL THEN 'ORGAO' ELSE 'FINANCEIRO' END,
    coalesce(ato_orgao_id, autorizacao_id), etapa, id, ata_documento_id, versao_id, referencia_externa, justificativa, sequencia, registrado_por_id, criado_em
  FROM referencia_ata_institucional;

CREATE VIEW e09_alvo AS
  SELECT e.igreja_id, 'MEMBRESIA'::text AS grupo, e.id AS alvo_id, 'ATO'::text AS etapa,
    e.tipo_evento::text AS tipo, p.nome_completo AS titulo, e.data_evento AS data, NULL::text AS orgao_id,
    'CONSELHO'::text AS criterio, e.motivacao_evento = 'EXCLUSAO_POR_DISCIPLINA' AS sensivel,
    TRUE AS acompanha
  FROM eventos_membresia e JOIN pessoas p ON p.id = e.pessoa_id AND p.igreja_id = e.igreja_id
  UNION ALL
  SELECT m.igreja_id, 'MANDATO', m.id, x.etapa, x.etapa, p.nome_completo, x.data, NULL,
    CASE WHEN x.etapa = 'ELEICAO' THEN 'ASSEMBLEIA' ELSE 'CONSELHO' END, FALSE, TRUE
  FROM mandato_oficial m JOIN oficial o ON o.id = m.oficial_id AND o.igreja_id = m.igreja_id
  JOIN pessoas p ON p.id = o.pessoa_id AND p.igreja_id = o.igreja_id
  CROSS JOIN LATERAL (VALUES ('ELEICAO', m.data_eleicao), ('POSSE', m.data_posse), ('ENCERRAMENTO', m.termino_efetivo)) x(etapa, data)
  WHERE x.data IS NOT NULL
  UNION ALL
  SELECT v.igreja_id, 'PASTORAL', v.id, x.etapa, x.etapa, p.nome_completo, x.data, NULL, 'CONSELHO', FALSE, TRUE
  FROM vinculo_pastoral v JOIN oficial o ON o.id = v.oficial_id AND o.igreja_id = v.igreja_id
  JOIN pessoas p ON p.id = o.pessoa_id AND p.igreja_id = o.igreja_id
  CROSS JOIN LATERAL (VALUES ('INICIO', v.data_inicio), ('ENCERRAMENTO', v.data_fim)) x(etapa, data)
  WHERE x.data IS NOT NULL
  UNION ALL
  SELECT a.igreja_id, 'ORGAO', a.id, x.etapa, a.tipo,
    coalesce(a.retrato #>> '{orgao,nome}', o.nome), x.data, a.orgao_id,
    CASE WHEN a.tipo IN ('INSTITUICAO','DESATIVACAO','DESIGNACAO','DISPENSA') AND o.tipo = 'UNIDADE_MINISTERIAL' THEN 'CONSELHO'
         WHEN a.tipo = 'INSTITUICAO' THEN 'CONSELHO_OU_ASSEMBLEIA'
         ELSE 'ORGAO' END,
    FALSE, a.tipo NOT IN ('PARTICIPACAO_INCLUSAO','PARTICIPACAO_SAIDA','MANUTENCAO','CONFIGURACAO_CARGO','CONFIGURACAO_ACUMULACAO')
  FROM ato_orgao a JOIN orgao_interno o ON o.id = a.orgao_id AND o.igreja_id = a.igreja_id
  CROSS JOIN LATERAL (
    SELECT 'ATO' AS etapa, a.data_efeito AS data WHERE a.tipo NOT IN ('ELEICAO_CARGO','ELEICAO_CARGO_UNIDADE')
    UNION ALL SELECT 'ELEICAO', (a.detalhes->>'data_eleicao')::date WHERE a.tipo IN ('ELEICAO_CARGO','ELEICAO_CARGO_UNIDADE')
    UNION ALL SELECT 'POSSE', a.data_efeito WHERE a.tipo IN ('ELEICAO_CARGO','ELEICAO_CARGO_UNIDADE')
  ) x
  UNION ALL
  SELECT f.igreja_id, 'FINANCEIRO', f.id, 'ATO', f.tipo, f.assunto, f.data_decisao, NULL, 'CONSELHO_OU_ASSEMBLEIA', FALSE, TRUE
  FROM autorizacao_financeira_documental f;
