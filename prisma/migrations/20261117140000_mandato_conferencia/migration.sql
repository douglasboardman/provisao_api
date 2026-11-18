ALTER TABLE "mandato_oficial" ADD COLUMN "conferencia_id" TEXT;
CREATE UNIQUE INDEX "conferencia_eleicao_oficial_id_igreja_id_key" ON "conferencia_eleicao_oficial"("id", "igreja_id");
ALTER TABLE "mandato_oficial" ADD CONSTRAINT "mandato_conferencia_igreja_fkey" FOREIGN KEY ("conferencia_id", "igreja_id") REFERENCES "conferencia_eleicao_oficial"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Serializa novas conferências de mandato com mudanças da mesma pessoa na membresia.
-- Históricos anteriores a mandato exigem revisão de impacto, ainda não implementada.
CREATE FUNCTION proteger_membresia_de_mandato() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE igreja text; pessoa text; data_relevante date;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.igreja_id, OLD.pessoa_id) IS DISTINCT FROM (NEW.igreja_id, NEW.pessoa_id) THEN
    RAISE EXCEPTION 'Troca de igreja ou pessoa em evento de membresia não é permitida' USING ERRCODE = '23514';
  END IF;
  igreja := CASE WHEN TG_OP = 'DELETE' THEN OLD.igreja_id ELSE NEW.igreja_id END;
  pessoa := CASE WHEN TG_OP = 'DELETE' THEN OLD.pessoa_id ELSE NEW.pessoa_id END;
  PERFORM id FROM pessoas WHERE id = pessoa AND igreja_id = igreja FOR UPDATE;
  IF TG_OP = 'UPDATE' AND (OLD.tipo_evento, OLD.rol, OLD.motivacao_evento, OLD.data_evento) IS NOT DISTINCT FROM (NEW.tipo_evento, NEW.rol, NEW.motivacao_evento, NEW.data_evento) THEN
    RETURN NEW;
  END IF;
  data_relevante := CASE WHEN TG_OP = 'INSERT' THEN NEW.data_evento WHEN TG_OP = 'DELETE' THEN OLD.data_evento ELSE LEAST(OLD.data_evento, NEW.data_evento) END;
  IF EXISTS (SELECT 1 FROM mandato_oficial m JOIN oficial o ON o.id = m.oficial_id AND o.igreja_id = m.igreja_id
      WHERE o.igreja_id = igreja AND o.pessoa_id = pessoa AND data_relevante <= m.data_posse) THEN
    RAISE EXCEPTION 'Alteração de membresia exige conferência de impacto em mandato' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER membresia_proteger_mandato BEFORE INSERT OR UPDATE OR DELETE ON eventos_membresia
  FOR EACH ROW EXECUTE FUNCTION proteger_membresia_de_mandato();

CREATE FUNCTION proteger_nascimento_de_mandato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.data_nascimento IS DISTINCT FROM NEW.data_nascimento AND EXISTS (
    SELECT 1 FROM mandato_oficial m JOIN oficial o ON o.id = m.oficial_id AND o.igreja_id = m.igreja_id
    WHERE o.igreja_id = OLD.igreja_id AND o.pessoa_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Alteração de nascimento exige conferência de impacto em mandato' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pessoas_proteger_nascimento BEFORE UPDATE OF data_nascimento ON pessoas
  FOR EACH ROW EXECUTE FUNCTION proteger_nascimento_de_mandato();
