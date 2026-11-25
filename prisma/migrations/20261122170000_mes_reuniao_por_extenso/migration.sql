BEGIN;
CREATE FUNCTION instalar_mes_reuniao_por_extenso(destino TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria (id, igreja_id, codigo, nome, tipo, multiplo, origem)
  VALUES (gen_random_uuid()::text, destino, 'MES_REUNIAO_POR_EXTENSO', 'Mês da reunião por extenso', 'texto', false, 'mes_reuniao_por_extenso')
  ON CONFLICT (igreja_id, codigo) DO NOTHING
$$;
SELECT instalar_mes_reuniao_por_extenso(id) FROM igreja;
CREATE OR REPLACE FUNCTION instalar_campos_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_secretaria(NEW.id);
  PERFORM instalar_mes_reuniao_por_extenso(NEW.id);
  RETURN NEW;
END $$;
COMMIT;
