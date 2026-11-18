-- Alterar ordens exige registro e itens da conferência na mesma transação.
CREATE OR REPLACE FUNCTION validar_ordem_nova_membresia() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total integer; sem_ordem integer; maior integer;
BEGIN
  PERFORM id FROM pessoas WHERE id = NEW.pessoa_id AND igreja_id = NEW.igreja_id FOR UPDATE;
  IF TG_OP = 'UPDATE' AND OLD.ordem_dia IS DISTINCT FROM NEW.ordem_dia THEN
    IF (OLD.id, OLD.igreja_id, OLD.pessoa_id, OLD.data_evento, OLD.tipo_evento, OLD.rol, OLD.rol_origem, OLD.motivacao_evento, OLD.igreja_origem, OLD.igreja_destino, OLD.observacoes, OLD.created_at)
       IS DISTINCT FROM (NEW.id, NEW.igreja_id, NEW.pessoa_id, NEW.data_evento, NEW.tipo_evento, NEW.rol, NEW.rol_origem, NEW.motivacao_evento, NEW.igreja_origem, NEW.igreja_destino, NEW.observacoes, NEW.created_at)
       OR NOT EXISTS (SELECT 1 FROM ordenacao_membresia o JOIN item_ordenacao_membresia i ON i.ordenacao_id = o.id AND i.igreja_id = o.igreja_id AND i.pessoa_id = o.pessoa_id
         WHERE o.id = current_setting('provisao.ordenacao_id', true) AND o.igreja_id = OLD.igreja_id AND o.pessoa_id = OLD.pessoa_id
           AND o.data_evento = OLD.data_evento AND i.evento_id = OLD.id AND (NEW.ordem_dia IS NULL OR NEW.ordem_dia = i.ordem_nova))
    THEN RAISE EXCEPTION 'Alteração de ordem exige conferência auditada' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.data_evento IS NOT DISTINCT FROM NEW.data_evento THEN RETURN NEW; END IF;
  SELECT count(*), count(*) FILTER (WHERE ordem_dia IS NULL), max(ordem_dia) INTO total, sem_ordem, maior
    FROM eventos_membresia WHERE igreja_id = NEW.igreja_id AND pessoa_id = NEW.pessoa_id AND data_evento = NEW.data_evento AND id <> NEW.id;
  IF total > 0 AND (NEW.ordem_dia IS NULL OR sem_ordem > 0 OR NEW.ordem_dia <= maior) THEN
    RAISE EXCEPTION 'Atos no mesmo dia exigem ordem explícita e posterior; confira o histórico existente' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER "validar_ordem_membresia_nova" ON "eventos_membresia";
CREATE TRIGGER "validar_ordem_membresia_nova" BEFORE INSERT OR UPDATE OF "data_evento", "ordem_dia" ON "eventos_membresia"
  FOR EACH ROW EXECUTE FUNCTION validar_ordem_nova_membresia();
