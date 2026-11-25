BEGIN;
CREATE FUNCTION instalar_dia_ano_reuniao_por_extenso(destino TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria(id, igreja_id, codigo, nome, tipo, multiplo, origem)
  SELECT gen_random_uuid()::text, destino, upper(chave), rotulo, 'texto', false, chave
  FROM (VALUES
    ('dia_reuniao_por_extenso', 'Dia da reunião por extenso'),
    ('ano_reuniao_por_extenso', 'Ano da reunião por extenso')
  ) campos(chave, rotulo)
  ON CONFLICT (igreja_id, codigo) DO NOTHING
$$;
SELECT instalar_dia_ano_reuniao_por_extenso(id) FROM igreja;
CREATE OR REPLACE FUNCTION instalar_campos_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_secretaria(NEW.id);
  PERFORM instalar_mes_reuniao_por_extenso(NEW.id);
  PERFORM instalar_dia_ano_reuniao_por_extenso(NEW.id);
  RETURN NEW;
END $$;
COMMIT;
