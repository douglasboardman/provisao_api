-- Um mandato preserva a fonte e os dados que sustentaram sua conferência.
CREATE FUNCTION proteger_conferencia_de_mandato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mandato_oficial WHERE conferencia_id = OLD.id AND igreja_id = OLD.igreja_id) THEN
    RAISE EXCEPTION 'Conferência referenciada por mandato não pode ser alterada' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER conferencia_proteger_mandato BEFORE UPDATE OR DELETE ON conferencia_eleicao_oficial
  FOR EACH ROW EXECUTE FUNCTION proteger_conferencia_de_mandato();
CREATE FUNCTION proteger_politica_de_mandato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM conferencia_eleicao_oficial c JOIN mandato_oficial m ON m.conferencia_id = c.id AND m.igreja_id = c.igreja_id WHERE c.politica_id = OLD.id AND c.igreja_id = OLD.igreja_id) THEN
    RAISE EXCEPTION 'Política referenciada por mandato não pode ser alterada' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER politica_proteger_mandato BEFORE UPDATE OR DELETE ON politica_eleicao_oficial
  FOR EACH ROW EXECUTE FUNCTION proteger_politica_de_mandato();
