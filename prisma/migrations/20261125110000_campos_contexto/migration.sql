BEGIN;

INSERT INTO origem_campo_secretaria (chave, cadastro, propriedade, transformacao) VALUES
  ('contexto_nome', 'contexto', 'nome', NULL),
  ('contexto_sigla', 'contexto', 'sigla', NULL),
  ('contexto_por_extenso', 'contexto', 'nome', 'por_extenso');

CREATE FUNCTION instalar_campos_contexto(destino text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria (id, igreja_id, codigo, nome, tipo, multiplo, origem)
  SELECT gen_random_uuid()::text, destino,
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM campo_secretaria WHERE igreja_id = destino AND codigo = upper(c.chave)
    ) THEN upper(c.chave) END,
    c.nome, 'texto', false, c.chave
  FROM (VALUES
    ('contexto_nome', 'Nome do contexto'),
    ('contexto_sigla', 'Sigla do contexto'),
    ('contexto_por_extenso', 'Contexto por extenso')
  ) AS c(chave, nome)
  WHERE NOT EXISTS (SELECT 1 FROM campo_secretaria WHERE igreja_id = destino AND origem = c.chave)
$$;

SELECT instalar_campos_contexto(id) FROM igreja;

CREATE OR REPLACE FUNCTION instalar_origens_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_convocacao(NEW.id);
  PERFORM instalar_campo_secretario_livro(NEW.id);
  PERFORM instalar_campo_deliberacoes(NEW.id);
  PERFORM instalar_campos_contexto(NEW.id);
  RETURN NEW;
END $$;

COMMIT;
