BEGIN;
ALTER TABLE resolucao ADD COLUMN reuniao_pauta_id text;
ALTER TABLE item_pauta_reuniao ADD CONSTRAINT item_pauta_reuniao_id_reuniao_key UNIQUE (id, reuniao_id);
ALTER TABLE documento_versao ADD CONSTRAINT documento_versao_id_reuniao_key UNIQUE (id, reuniao_id);

-- O bloqueio exclusivo da alteração de esquema cobre a carga dos vínculos históricos.
-- Apenas a nova coluna derivada é preenchida, inclusive nas versões já congeladas.
ALTER TABLE resolucao DISABLE TRIGGER e08_preservar_resolucao;
UPDATE resolucao r SET reuniao_pauta_id = i.reuniao_id
FROM item_pauta_reuniao i WHERE i.id = r.item_pauta_id;
ALTER TABLE resolucao ENABLE TRIGGER e08_preservar_resolucao;

ALTER TABLE resolucao
  ADD CONSTRAINT resolucao_pauta_completa CHECK ((item_pauta_id IS NULL) = (reuniao_pauta_id IS NULL)),
  ADD CONSTRAINT resolucao_item_reuniao_fkey FOREIGN KEY (item_pauta_id, reuniao_pauta_id)
    REFERENCES item_pauta_reuniao(id, reuniao_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT resolucao_versao_reuniao_fkey FOREIGN KEY (versao_id, reuniao_pauta_id)
    REFERENCES documento_versao(id, reuniao_id) DEFERRABLE INITIALLY DEFERRED,
  DROP CONSTRAINT resolucao_item_pauta_id_fkey;

-- Clientes fornecem somente o item. As duas FKs garantem que os pais continuem
-- na mesma reunião, inclusive quando uma atualização concorrente move a versão.
DROP TRIGGER resolucao_item_da_reuniao ON resolucao;
DROP FUNCTION conferir_item_da_resolucao();
CREATE FUNCTION preencher_reuniao_da_pauta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.reuniao_pauta_id := (SELECT reuniao_id FROM item_pauta_reuniao WHERE id = NEW.item_pauta_id);
  RETURN NEW;
END $$;
CREATE TRIGGER resolucao_preencher_reuniao BEFORE INSERT OR UPDATE OF item_pauta_id, reuniao_pauta_id ON resolucao
  FOR EACH ROW EXECUTE FUNCTION preencher_reuniao_da_pauta();
COMMIT;
