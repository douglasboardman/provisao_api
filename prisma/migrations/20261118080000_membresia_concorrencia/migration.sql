-- Confere o histórico novamente sob o bloqueio da pessoa: leitura anterior do cliente pode estar desatualizada.
CREATE OR REPLACE FUNCTION validar_ordem_nova_membresia() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total integer; sem_ordem integer; maior integer; ultima_data date; ultimo_rol membresia_rol; ultimo_total integer; ultimo_sem_ordem integer;
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
  IF TG_OP = 'INSERT' THEN
    SELECT max(data_evento) INTO ultima_data FROM eventos_membresia WHERE igreja_id = NEW.igreja_id AND pessoa_id = NEW.pessoa_id;
    IF ultima_data > NEW.data_evento THEN RAISE EXCEPTION 'Evento anterior ao último registro exige correção retroativa' USING ERRCODE = '23514'; END IF;
    IF ultima_data IS NOT NULL THEN
      SELECT count(*), count(*) FILTER (WHERE ordem_dia IS NULL) INTO ultimo_total, ultimo_sem_ordem FROM eventos_membresia WHERE igreja_id = NEW.igreja_id AND pessoa_id = NEW.pessoa_id AND data_evento = ultima_data;
      IF ultimo_total > 1 AND ultimo_sem_ordem > 0 THEN RAISE EXCEPTION 'Ordem dos atos mais recentes exige conferência' USING ERRCODE = '23514'; END IF;
      SELECT rol INTO ultimo_rol FROM eventos_membresia WHERE igreja_id = NEW.igreja_id AND pessoa_id = NEW.pessoa_id AND data_evento = ultima_data ORDER BY ordem_dia DESC NULLS LAST LIMIT 1;
      IF NEW.tipo_evento = 'MUDANCA_DE_ROL' AND NEW.rol_origem IS DISTINCT FROM ultimo_rol THEN RAISE EXCEPTION 'Rol de origem desatualizado; consulte o histórico novamente' USING ERRCODE = '23514'; END IF;
    END IF;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE ordem_dia IS NULL), max(ordem_dia) INTO total, sem_ordem, maior
    FROM eventos_membresia WHERE igreja_id = NEW.igreja_id AND pessoa_id = NEW.pessoa_id AND data_evento = NEW.data_evento AND id <> NEW.id;
  IF total > 0 AND (NEW.ordem_dia IS NULL OR sem_ordem > 0 OR NEW.ordem_dia <= maior) THEN RAISE EXCEPTION 'Atos no mesmo dia exigem ordem explícita e posterior; confira o histórico existente' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
