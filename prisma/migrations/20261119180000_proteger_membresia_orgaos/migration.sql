-- Bloqueio conservador até existir decisão e revisão de impacto próprias da E03.
-- Não modifica os controles da E02 nem interpreta decisão eleitoral como autorização
-- para alterar a base de um ato de órgão.
CREATE FUNCTION proteger_membresia_de_orgaos() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  igreja text;
  pessoa text;
  data_relevante date;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.igreja_id, OLD.pessoa_id) IS DISTINCT FROM (NEW.igreja_id, NEW.pessoa_id) THEN
    RAISE EXCEPTION 'Troca de igreja ou pessoa em evento de membresia não é permitida' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.data_evento, OLD.ordem_dia, OLD.rol) IS NOT DISTINCT FROM (NEW.data_evento, NEW.ordem_dia, NEW.rol) THEN
    RETURN NEW;
  END IF;
  igreja := CASE WHEN TG_OP = 'DELETE' THEN OLD.igreja_id ELSE NEW.igreja_id END;
  pessoa := CASE WHEN TG_OP = 'DELETE' THEN OLD.pessoa_id ELSE NEW.pessoa_id END;
  PERFORM id FROM pessoas WHERE id = pessoa AND igreja_id = igreja FOR UPDATE;
  data_relevante := CASE WHEN TG_OP = 'INSERT' THEN NEW.data_evento WHEN TG_OP = 'DELETE' THEN OLD.data_evento ELSE LEAST(OLD.data_evento, NEW.data_evento) END;
  IF EXISTS (SELECT 1 FROM membro_orgao WHERE igreja_id = igreja AND pessoa_id = pessoa AND inicio >= data_relevante)
     OR EXISTS (SELECT 1 FROM ocupacao_cargo WHERE igreja_id = igreja AND pessoa_id = pessoa AND inicio >= data_relevante) THEN
    RAISE EXCEPTION 'Alteração de membresia exige revisão de impacto em órgão ou cargo' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER "membresia_proteger_orgaos" BEFORE INSERT OR UPDATE OR DELETE ON "eventos_membresia"
  FOR EACH ROW EXECUTE FUNCTION proteger_membresia_de_orgaos();
