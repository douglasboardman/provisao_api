BEGIN;
ALTER TABLE resolucao ADD COLUMN item_pauta_id text REFERENCES item_pauta_reuniao(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX resolucao_item_pauta_id_idx ON resolucao(item_pauta_id);
CREATE FUNCTION conferir_item_da_resolucao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_pauta_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM item_pauta_reuniao i JOIN documento_versao v ON v.reuniao_id = i.reuniao_id
    WHERE i.id = NEW.item_pauta_id AND v.id = NEW.versao_id
      AND i.igreja_id = NEW.igreja_id AND i.contexto_id = NEW.contexto_id
  ) THEN RAISE EXCEPTION 'Item de pauta não pertence à reunião da resolução.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resolucao_item_da_reuniao BEFORE INSERT OR UPDATE OF item_pauta_id, versao_id ON resolucao
  FOR EACH ROW EXECUTE FUNCTION conferir_item_da_resolucao();

INSERT INTO origem_campo_secretaria (chave,cadastro,propriedade)
VALUES ('deliberacoes_reuniao','documento','resolucoes');
CREATE FUNCTION instalar_campo_deliberacoes(destino text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria (id,igreja_id,codigo,nome,tipo,multiplo,origem)
  SELECT gen_random_uuid()::text, destino,
    CASE WHEN NOT EXISTS (SELECT 1 FROM campo_secretaria WHERE igreja_id=destino AND codigo='DELIBERACOES_REUNIAO')
      THEN 'DELIBERACOES_REUNIAO' END,
    'Deliberações da reunião', 'texto', true, 'deliberacoes_reuniao'
  WHERE NOT EXISTS (SELECT 1 FROM campo_secretaria WHERE igreja_id=destino AND origem='deliberacoes_reuniao')
$$;
SELECT instalar_campo_deliberacoes(id) FROM igreja;
CREATE OR REPLACE FUNCTION instalar_origens_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_convocacao(NEW.id);
  PERFORM instalar_campo_secretario_livro(NEW.id);
  PERFORM instalar_campo_deliberacoes(NEW.id);
  RETURN NEW;
END $$;
COMMIT;
