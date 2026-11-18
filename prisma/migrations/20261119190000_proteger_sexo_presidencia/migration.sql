-- Alterar o dado usado para apurar a presidência exige revisão institucional.
CREATE FUNCTION proteger_sexo_presidencia() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sexo IS DISTINCT FROM NEW.sexo AND EXISTS (
    SELECT 1 FROM oficial o JOIN presidencia_conselho p ON p.oficial_id = o.id AND p.igreja_id = o.igreja_id
    WHERE o.igreja_id = OLD.igreja_id AND o.pessoa_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Alteração cadastral exige revisão de impacto em presidência' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pessoas_proteger_sexo_presidencia BEFORE UPDATE OF sexo ON pessoas
  FOR EACH ROW EXECUTE FUNCTION proteger_sexo_presidencia();
