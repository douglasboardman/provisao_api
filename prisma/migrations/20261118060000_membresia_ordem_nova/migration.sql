-- Novos fatos no mesmo dia não podem introduzir ordem ambígua.
CREATE FUNCTION validar_ordem_nova_membresia() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total integer; sem_ordem integer; maior integer;
BEGIN
  PERFORM id FROM pessoas WHERE id = NEW.pessoa_id AND igreja_id = NEW.igreja_id FOR UPDATE;
  SELECT count(*), count(*) FILTER (WHERE ordem_dia IS NULL), max(ordem_dia) INTO total, sem_ordem, maior
    FROM eventos_membresia WHERE igreja_id = NEW.igreja_id AND pessoa_id = NEW.pessoa_id AND data_evento = NEW.data_evento;
  IF total > 0 AND (NEW.ordem_dia IS NULL OR sem_ordem > 0 OR NEW.ordem_dia <= maior) THEN
    RAISE EXCEPTION 'Atos no mesmo dia exigem ordem explícita e posterior; confira o histórico existente' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validar_ordem_membresia_nova BEFORE INSERT ON eventos_membresia
  FOR EACH ROW EXECUTE FUNCTION validar_ordem_nova_membresia();
