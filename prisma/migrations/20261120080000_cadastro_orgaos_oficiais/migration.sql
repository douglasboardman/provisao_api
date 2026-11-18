BEGIN;

-- Metadados históricos existentes são preservados. Unidades mantêm seus requisitos.
ALTER TABLE orgao_interno ALTER COLUMN instituidor_id DROP NOT NULL,
  ALTER COLUMN evidencia_instituicao DROP NOT NULL;
ALTER TABLE orgao_interno DROP CONSTRAINT orgao_dados_obrigatorios,
  ADD CONSTRAINT orgao_dados_obrigatorios CHECK (
    length(btrim(nome)) > 0 AND length(btrim(finalidade)) > 0
    AND (evidencia_instituicao IS NULL OR length(btrim(evidencia_instituicao)) > 0)
    AND (tipo IN ('CONSELHO', 'JUNTA') OR
      (instituidor_id IS NOT NULL AND evidencia_instituicao IS NOT NULL))
  );

-- Cadastro administrativo não declara uma autoridade ou evidência institucional fictícia.
ALTER TABLE ato_orgao ALTER COLUMN autoridade DROP NOT NULL,
  ALTER COLUMN evidencia DROP NOT NULL;
ALTER TABLE ato_orgao DROP CONSTRAINT ato_orgao_evidencia,
  ADD CONSTRAINT ato_orgao_evidencia CHECK (
    (tipo = 'CADASTRO_OFICIAL' AND autoridade IS NULL AND evidencia IS NULL)
    OR (tipo <> 'CADASTRO_OFICIAL' AND autoridade IS NOT NULL AND evidencia IS NOT NULL
      AND length(btrim(autoridade)) > 0 AND length(btrim(evidencia)) > 0)
  );

CREATE FUNCTION validar_cadastro_orgao_oficial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tipo = 'CADASTRO_OFICIAL' AND NOT EXISTS (
    SELECT 1 FROM orgao_interno o WHERE o.id = NEW.orgao_id AND o.igreja_id = NEW.igreja_id
      AND o.tipo IN ('CONSELHO', 'JUNTA')
  ) THEN
    RAISE EXCEPTION 'Cadastro oficial exige Conselho ou Junta da mesma igreja' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validar_cadastro_orgao_oficial BEFORE INSERT OR UPDATE ON ato_orgao
  FOR EACH ROW EXECUTE FUNCTION validar_cadastro_orgao_oficial();

CREATE OR REPLACE VIEW e09_alvo AS
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
    FALSE, a.tipo NOT IN ('CADASTRO_OFICIAL','PARTICIPACAO_INCLUSAO','PARTICIPACAO_SAIDA','MANUTENCAO','CONFIGURACAO_CARGO','CONFIGURACAO_ACUMULACAO')
  FROM ato_orgao a JOIN orgao_interno o ON o.id = a.orgao_id AND o.igreja_id = a.igreja_id
  CROSS JOIN LATERAL (
    SELECT 'ATO' AS etapa, a.data_efeito AS data WHERE a.tipo NOT IN ('ELEICAO_CARGO','ELEICAO_CARGO_UNIDADE')
    UNION ALL SELECT 'ELEICAO', (a.detalhes->>'data_eleicao')::date WHERE a.tipo IN ('ELEICAO_CARGO','ELEICAO_CARGO_UNIDADE')
    UNION ALL SELECT 'POSSE', a.data_efeito WHERE a.tipo IN ('ELEICAO_CARGO','ELEICAO_CARGO_UNIDADE')
  ) x
  UNION ALL
  SELECT f.igreja_id, 'FINANCEIRO', f.id, 'ATO', f.tipo, f.assunto, f.data_decisao, NULL, 'CONSELHO_OU_ASSEMBLEIA', FALSE, TRUE
  FROM autorizacao_financeira_documental f;

COMMIT;
