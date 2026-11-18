-- A exceção transacional não autoriza alterar outros campos do evento.
CREATE OR REPLACE FUNCTION proteger_membresia_de_mandato() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE igreja text; pessoa text; data_relevante date;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.igreja_id, OLD.pessoa_id) IS DISTINCT FROM (NEW.igreja_id, NEW.pessoa_id) THEN
    RAISE EXCEPTION 'Troca de igreja ou pessoa em evento de membresia não é permitida' USING ERRCODE = '23514';
  END IF;
  igreja := CASE WHEN TG_OP = 'DELETE' THEN OLD.igreja_id ELSE NEW.igreja_id END;
  pessoa := CASE WHEN TG_OP = 'DELETE' THEN OLD.pessoa_id ELSE NEW.pessoa_id END;
  PERFORM id FROM pessoas WHERE id = pessoa AND igreja_id = igreja FOR UPDATE;
  IF TG_OP = 'UPDATE' AND (OLD.tipo_evento, OLD.rol, OLD.motivacao_evento, OLD.data_evento) IS NOT DISTINCT FROM (NEW.tipo_evento, NEW.rol, NEW.motivacao_evento, NEW.data_evento) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND current_setting('provisao.correcao_evento', true) = OLD.id
     AND current_setting('provisao.correcao_data', true) = NEW.data_evento::text
     AND (OLD.id, OLD.igreja_id, OLD.pessoa_id, OLD.tipo_evento, OLD.rol, OLD.motivacao_evento, OLD.rol_origem, OLD.igreja_origem, OLD.igreja_destino, OLD.observacoes, OLD.created_at)
       IS NOT DISTINCT FROM (NEW.id, NEW.igreja_id, NEW.pessoa_id, NEW.tipo_evento, NEW.rol, NEW.motivacao_evento, NEW.rol_origem, NEW.igreja_origem, NEW.igreja_destino, NEW.observacoes, NEW.created_at)
     AND EXISTS (SELECT 1 FROM correcao_data_membresia c WHERE c.id = current_setting('provisao.correcao_id', true)
       AND c.igreja_id = OLD.igreja_id AND c.evento_id = OLD.id AND c.data_anterior = OLD.data_evento AND c.data_nova = NEW.data_evento)
  THEN RETURN NEW; END IF;
  data_relevante := CASE WHEN TG_OP = 'INSERT' THEN NEW.data_evento WHEN TG_OP = 'DELETE' THEN OLD.data_evento ELSE LEAST(OLD.data_evento, NEW.data_evento) END;
  IF EXISTS (SELECT 1 FROM mandato_oficial m JOIN oficial o ON o.id = m.oficial_id AND o.igreja_id = m.igreja_id WHERE o.igreja_id = igreja AND o.pessoa_id = pessoa AND data_relevante <= m.data_posse) THEN
    RAISE EXCEPTION 'Alteração de membresia exige conferência de impacto em mandato' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
