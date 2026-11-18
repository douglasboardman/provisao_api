CREATE TABLE imagem_modelo_documento (
  versao_id TEXT NOT NULL,
  igreja_id TEXT NOT NULL,
  contexto_id TEXT NOT NULL,
  arquivo_id TEXT NOT NULL,
  CONSTRAINT imagem_modelo_documento_pkey PRIMARY KEY (versao_id, arquivo_id),
  CONSTRAINT imagem_modelo_versao_fkey FOREIGN KEY (versao_id, igreja_id, contexto_id)
    REFERENCES modelo_documento_versao(id, igreja_id, contexto_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT imagem_modelo_arquivo_fkey FOREIGN KEY (arquivo_id, igreja_id)
    REFERENCES arquivo_privado(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION impedir_alteracao_imagem_modelo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Imagem de versão do modelo é imutável';
END $$;
CREATE TRIGGER preservar_imagem_modelo BEFORE UPDATE OR DELETE ON imagem_modelo_documento
FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_imagem_modelo();

CREATE OR REPLACE FUNCTION proteger_arquivo_artefato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trabalho_renderizacao WHERE arquivo_id = OLD.id)
    OR EXISTS (SELECT 1 FROM imagem_modelo_documento WHERE arquivo_id = OLD.id)
    OR EXISTS (SELECT 1 FROM anexo_documento a JOIN documento_versao v ON v.id = a.versao_id
      WHERE a.arquivo_id = OLD.id AND v.congelado_em IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Metadados do arquivo arquivado são imutáveis';
  END IF;
  RETURN NEW;
END $$;
