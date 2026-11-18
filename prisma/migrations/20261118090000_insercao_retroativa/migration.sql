CREATE TABLE insercao_retroativa_membresia (
 id TEXT PRIMARY KEY, igreja_id TEXT NOT NULL, pessoa_id TEXT NOT NULL, evento_id TEXT NOT NULL UNIQUE,
 data_evento DATE NOT NULL, dados_evento JSONB NOT NULL, impacto JSONB NOT NULL,
 justificativa VARCHAR(1000) NOT NULL CHECK (length(btrim(justificativa)) > 0),
 autoridade VARCHAR(255) NOT NULL CHECK (length(btrim(autoridade)) > 0),
 evidencia VARCHAR(1000) NOT NULL CHECK (length(btrim(evidencia)) > 0),
 idempotencia UUID NOT NULL, criado_por_id TEXT NOT NULL, criado_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE (igreja_id, idempotencia), UNIQUE (evento_id, igreja_id, pessoa_id),
 FOREIGN KEY (pessoa_id, igreja_id) REFERENCES pessoas(id, igreja_id) ON DELETE RESTRICT,
 FOREIGN KEY (criado_por_id, igreja_id) REFERENCES usuarios(id, igreja_id) ON DELETE RESTRICT,
 FOREIGN KEY (evento_id, igreja_id, pessoa_id) REFERENCES eventos_membresia(id, igreja_id, pessoa_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX insercao_retroativa_membresia_igreja_id_pessoa_id_idx ON insercao_retroativa_membresia(igreja_id, pessoa_id);
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
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM insercao_retroativa_membresia r
    WHERE r.id = current_setting('provisao.insercao_retroativa_id', true)
      AND r.igreja_id = NEW.igreja_id AND r.pessoa_id = NEW.pessoa_id AND r.evento_id = NEW.id AND r.data_evento = NEW.data_evento
      AND r.dados_evento = jsonb_build_object('tipo_evento', NEW.tipo_evento::text, 'rol', NEW.rol::text, 'rol_origem', NEW.rol_origem::text, 'motivacao_evento', NEW.motivacao_evento::text, 'ordem_dia', NEW.ordem_dia, 'igreja_origem', NEW.igreja_origem, 'igreja_destino', NEW.igreja_destino, 'observacoes', NEW.observacoes)
  ) THEN RETURN NEW; END IF;
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
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM insercao_retroativa_membresia r
    WHERE r.id = current_setting('provisao.insercao_retroativa_id', true)
      AND r.igreja_id = NEW.igreja_id AND r.pessoa_id = NEW.pessoa_id AND r.evento_id = NEW.id AND r.data_evento = NEW.data_evento
      AND r.dados_evento = jsonb_build_object('tipo_evento', NEW.tipo_evento::text, 'rol', NEW.rol::text, 'rol_origem', NEW.rol_origem::text, 'motivacao_evento', NEW.motivacao_evento::text, 'ordem_dia', NEW.ordem_dia, 'igreja_origem', NEW.igreja_origem, 'igreja_destino', NEW.igreja_destino, 'observacoes', NEW.observacoes)
  ) THEN RETURN NEW; END IF;
  data_relevante := CASE WHEN TG_OP = 'INSERT' THEN NEW.data_evento WHEN TG_OP = 'DELETE' THEN OLD.data_evento ELSE LEAST(OLD.data_evento, NEW.data_evento) END;
  IF EXISTS (SELECT 1 FROM mandato_oficial m JOIN oficial o ON o.id = m.oficial_id AND o.igreja_id = m.igreja_id WHERE o.igreja_id = igreja AND o.pessoa_id = pessoa AND data_relevante <= m.data_posse) THEN
    RAISE EXCEPTION 'Alteração de membresia exige conferência de impacto em mandato' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
