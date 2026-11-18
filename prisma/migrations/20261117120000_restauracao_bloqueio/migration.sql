-- Bloquear atualizações do alvo durante a validação, inclusive campos que não são chave.
CREATE OR REPLACE FUNCTION validar_restauracao_oficial() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE alvo evento_oficial%ROWTYPE;
BEGIN
  IF NEW.tipo = 'RESTAURACAO' THEN
    SELECT * INTO alvo FROM evento_oficial WHERE id = NEW.evento_restaurado_id
      AND igreja_id = NEW.igreja_id AND oficial_id = NEW.oficial_id FOR SHARE;
    IF NOT FOUND OR alvo.tipo NOT IN ('LICENCA', 'SUSPENSAO', 'DISPONIBILIDADE', 'DEPOSICAO')
       OR (alvo.data_efeito, alvo.ordem) >= (NEW.data_efeito, NEW.ordem) THEN
      RAISE EXCEPTION 'Restauracao deve referenciar afastamento anterior do mesmo oficial' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
