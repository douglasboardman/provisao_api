BEGIN;
CREATE FUNCTION instalar_campo_redator_ata(destino TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria(id, igreja_id, codigo, nome, tipo, multiplo, origem)
  VALUES (gen_random_uuid()::text, destino, 'REDATOR_ATA', 'Redator da ata', 'texto', false, 'redator_ata')
  ON CONFLICT (igreja_id, codigo) DO NOTHING
$$;
SELECT instalar_campo_redator_ata(id) FROM igreja;
CREATE OR REPLACE FUNCTION instalar_campos_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_secretaria(NEW.id);
  PERFORM instalar_mes_reuniao_por_extenso(NEW.id);
  PERFORM instalar_dia_ano_reuniao_por_extenso(NEW.id);
  PERFORM instalar_campos_numero_documento(NEW.id);
  PERFORM instalar_campos_horario_reuniao(NEW.id);
  PERFORM instalar_campo_redator_ata(NEW.id);
  RETURN NEW;
END $$;
COMMIT;
