-- A referência deve encerrar um afastamento anterior, não uma ordenação ou outra restauração.
CREATE FUNCTION validar_restauracao_oficial() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE alvo evento_oficial%ROWTYPE;
BEGIN
  IF NEW.tipo = 'RESTAURACAO' THEN
    SELECT * INTO alvo FROM evento_oficial WHERE id = NEW.evento_restaurado_id
      AND igreja_id = NEW.igreja_id AND oficial_id = NEW.oficial_id FOR KEY SHARE;
    IF NOT FOUND OR alvo.tipo NOT IN ('LICENCA', 'SUSPENSAO', 'DISPONIBILIDADE', 'DEPOSICAO')
       OR (alvo.data_efeito, alvo.ordem) >= (NEW.data_efeito, NEW.ordem) THEN
      RAISE EXCEPTION 'Restauracao deve referenciar afastamento anterior do mesmo oficial' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evento_validar_restauracao BEFORE INSERT OR UPDATE ON evento_oficial
  FOR EACH ROW EXECUTE FUNCTION validar_restauracao_oficial();

-- Fatos que serviram de alvo não podem ser alterados por edição genérica.
CREATE FUNCTION preservar_evento_restaurado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM evento_oficial WHERE evento_restaurado_id = OLD.id) THEN
    RAISE EXCEPTION 'Evento referenciado por restauracao nao pode ser alterado' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evento_preservar_restaurado BEFORE UPDATE ON evento_oficial
  FOR EACH ROW EXECUTE FUNCTION preservar_evento_restaurado();
