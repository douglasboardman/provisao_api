-- A revisão fica congelada no registro da correção E02 e só autoriza a mesma
-- pessoa/igreja, na transação que já valida a alteração concreta pelo gatilho E02.
CREATE OR REPLACE FUNCTION proteger_membresia_de_orgaos() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 igreja text; pessoa text; data_relevante date; revisao jsonb; relatorio_impacto jsonb;
BEGIN
 IF TG_OP = 'UPDATE' AND (OLD.igreja_id, OLD.pessoa_id) IS DISTINCT FROM (NEW.igreja_id, NEW.pessoa_id) THEN
  RAISE EXCEPTION 'Troca de igreja ou pessoa em evento de membresia não é permitida' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND (OLD.data_evento, OLD.ordem_dia, OLD.rol) IS NOT DISTINCT FROM (NEW.data_evento, NEW.ordem_dia, NEW.rol) THEN RETURN NEW; END IF;
 igreja := CASE WHEN TG_OP = 'DELETE' THEN OLD.igreja_id ELSE NEW.igreja_id END;
 pessoa := CASE WHEN TG_OP = 'DELETE' THEN OLD.pessoa_id ELSE NEW.pessoa_id END;
 PERFORM id FROM pessoas WHERE id = pessoa AND igreja_id = igreja FOR UPDATE;
 data_relevante := CASE WHEN TG_OP = 'INSERT' THEN NEW.data_evento WHEN TG_OP = 'DELETE' THEN OLD.data_evento ELSE LEAST(OLD.data_evento, NEW.data_evento) END;
 IF EXISTS (SELECT 1 FROM membro_orgao WHERE igreja_id = igreja AND pessoa_id = pessoa AND inicio >= data_relevante)
 OR EXISTS (SELECT 1 FROM ocupacao_cargo WHERE igreja_id = igreja AND pessoa_id = pessoa AND inicio >= data_relevante) THEN
  IF TG_OP = 'UPDATE' THEN
   SELECT c.impacto INTO relatorio_impacto FROM correcao_data_membresia c JOIN eventos_membresia e ON e.id = c.evento_id
    WHERE c.id = current_setting('provisao.correcao_id', true) AND c.igreja_id = igreja AND e.pessoa_id = pessoa AND c.evento_id = NEW.id
    AND c.data_anterior = OLD.data_evento AND c.data_nova = NEW.data_evento;
   IF relatorio_impacto IS NULL THEN
    SELECT c.impacto INTO relatorio_impacto FROM correcao_conteudo_membresia c WHERE c.id = current_setting('provisao.correcao_conteudo_id', true)
     AND c.igreja_id = igreja AND c.pessoa_id = pessoa AND c.evento_id = NEW.id;
   END IF;
   IF relatorio_impacto IS NULL THEN
    SELECT c.impacto INTO relatorio_impacto FROM ordenacao_membresia c WHERE c.id = current_setting('provisao.ordenacao_id', true)
     AND c.igreja_id = igreja AND c.pessoa_id = pessoa AND c.data_evento = NEW.data_evento;
   END IF;
  ELSIF TG_OP = 'INSERT' THEN
   SELECT c.impacto INTO relatorio_impacto FROM insercao_retroativa_membresia c WHERE c.id = current_setting('provisao.insercao_retroativa_id', true)
    AND c.igreja_id = igreja AND c.pessoa_id = pessoa AND c.evento_id = NEW.id;
  END IF;
  revisao := relatorio_impacto->'revisao_orgaos';
  IF revisao IS NULL OR jsonb_typeof(revisao->'vinculos') IS DISTINCT FROM 'array'
   OR jsonb_typeof(revisao->'decisoes') IS DISTINCT FROM 'array'
   OR jsonb_array_length(revisao->'decisoes') = 0
   OR revisao->>'hash_previa' IS DISTINCT FROM relatorio_impacto->>'hash'
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(revisao->'decisoes') d WHERE NOT EXISTS (
    SELECT 1 FROM decisao_revisao_orgao r WHERE r.id = d->>'id' AND r.igreja_id = igreja AND r.pessoa_id = pessoa
    AND r.hash_previa = relatorio_impacto->>'hash' AND r.resultado = 'FAVORAVEL'))
   OR EXISTS (SELECT 1 FROM membro_orgao m WHERE m.igreja_id = igreja AND m.pessoa_id = pessoa AND m.inicio >= data_relevante AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(revisao->'vinculos') v WHERE v->>'id' = m.id AND v->>'tipo' = 'PARTICIPACAO'))
   OR EXISTS (SELECT 1 FROM ocupacao_cargo c WHERE c.igreja_id = igreja AND c.pessoa_id = pessoa AND c.inicio >= data_relevante AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(revisao->'vinculos') v WHERE v->>'id' = c.id AND v->>'tipo' = 'OCUPACAO')) THEN
   RAISE EXCEPTION 'Alteração de membresia exige revisão de impacto em órgão ou cargo' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
