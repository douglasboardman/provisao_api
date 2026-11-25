BEGIN;
CREATE TABLE local_reuniao (
  id TEXT PRIMARY KEY,
  igreja_id TEXT NOT NULL REFERENCES igreja(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  descritivo VARCHAR(255) NOT NULL CHECK (length(trim(descritivo)) > 0),
  endereco_logradouro TEXT NOT NULL DEFAULT '',
  endereco_numero TEXT NOT NULL DEFAULT '',
  endereco_complemento TEXT NOT NULL DEFAULT '',
  endereco_bairro TEXT NOT NULL DEFAULT '',
  endereco_cep TEXT NOT NULL DEFAULT '',
  endereco_cidade TEXT NOT NULL DEFAULT '',
  endereco_uf TEXT NOT NULL DEFAULT '',
  extenso_personalizado TEXT NOT NULL DEFAULT '',
  declarativo_personalizado TEXT NOT NULL DEFAULT '',
  revisao INTEGER NOT NULL DEFAULT 1,
  UNIQUE(id, igreja_id)
);
CREATE INDEX local_reuniao_igreja_id_descritivo_idx ON local_reuniao(igreja_id, descritivo);
ALTER TABLE reuniao ADD COLUMN local_id TEXT, ADD COLUMN local_retrato JSONB,
  ADD FOREIGN KEY (local_id, igreja_id) REFERENCES local_reuniao(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Nomes já registrados em reuniões (inclusive restritas) permanecem nos seus registros originais.

CREATE FUNCTION instalar_campos_local_reuniao(destino TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria(id, igreja_id, codigo, nome, tipo, multiplo, origem)
  SELECT gen_random_uuid()::text, destino, upper(chave), nome, 'texto', false, chave
  FROM (VALUES
    ('endereco_logradouro', 'Logradouro do local da reunião'),
    ('endereco_numero', 'Número do local da reunião'),
    ('endereco_complemento', 'Complemento do local da reunião'),
    ('endereco_bairro', 'Bairro do local da reunião'),
    ('endereco_cep', 'CEP do local da reunião'),
    ('endereco_cidade', 'Cidade do local da reunião'),
    ('endereco_uf', 'UF do local da reunião'),
    ('endereco_extenso', 'Endereço por extenso do local da reunião'),
    ('endereco_declarativo', 'Endereço declarativo do local da reunião')
  ) campos(chave, nome) ON CONFLICT (igreja_id, codigo) DO NOTHING
$$;
SELECT instalar_campos_local_reuniao(id) FROM igreja;
CREATE FUNCTION campos_local_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_local_reuniao(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER campos_local_reuniao_nova_igreja AFTER INSERT ON igreja
  FOR EACH ROW EXECUTE FUNCTION campos_local_nova_igreja();
COMMIT;
