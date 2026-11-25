BEGIN;
CREATE FUNCTION instalar_campos_horario_reuniao(destino TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria(id, igreja_id, codigo, nome, tipo, multiplo, origem)
  SELECT gen_random_uuid()::text, destino, upper(chave), nome, tipo, false, chave
  FROM (VALUES
    ('horario_inicio_reuniao', 'Horário de início da reunião', 'texto'),
    ('horario_inicio_reuniao_por_extenso', 'Horário de início da reunião por extenso', 'texto'),
    ('horario_encerramento_reuniao', 'Horário de encerramento da reunião', 'texto'),
    ('horario_encerramento_reuniao_por_extenso', 'Horário de encerramento da reunião por extenso', 'texto')
  ) campos(chave, nome, tipo)
  ON CONFLICT (igreja_id, codigo) DO NOTHING
$$;
SELECT instalar_campos_horario_reuniao(id) FROM igreja;
CREATE OR REPLACE FUNCTION instalar_campos_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_secretaria(NEW.id);
  PERFORM instalar_mes_reuniao_por_extenso(NEW.id);
  PERFORM instalar_dia_ano_reuniao_por_extenso(NEW.id);
  PERFORM instalar_campos_numero_documento(NEW.id);
  PERFORM instalar_campos_horario_reuniao(NEW.id);
  RETURN NEW;
END $$;
COMMIT;
