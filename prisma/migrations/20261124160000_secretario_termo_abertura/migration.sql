BEGIN;
INSERT INTO origem_campo_secretaria (chave,cadastro,propriedade)
VALUES ('nome_secretario_livro','pessoa','secretario_livro.nome');

CREATE FUNCTION instalar_campo_secretario_livro(destino text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria (id, igreja_id, codigo, nome, tipo, multiplo, origem)
  VALUES (gen_random_uuid()::text, destino, 'NOME_SECRETARIO_LIVRO', 'Secretário responsável pelo livro', 'texto', false, 'nome_secretario_livro')
  ON CONFLICT (igreja_id,codigo) DO NOTHING
$$;
SELECT instalar_campo_secretario_livro(id) FROM igreja;
CREATE OR REPLACE FUNCTION instalar_origens_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_convocacao(NEW.id);
  PERFORM instalar_campo_secretario_livro(NEW.id);
  RETURN NEW;
END $$;
COMMIT;
