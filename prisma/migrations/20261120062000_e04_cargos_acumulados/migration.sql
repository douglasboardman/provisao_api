-- Preserva colunas singulares para compatibilidade; novos vínculos admitem acumulações.
CREATE UNIQUE INDEX arrolado_documento_id_igreja_id_contexto_id_versao_id_key ON arrolado_documento(id, igreja_id, contexto_id, versao_id);
CREATE TABLE cargo_arrolado_documento (
  id TEXT PRIMARY KEY,
  igreja_id TEXT NOT NULL,
  contexto_id TEXT NOT NULL,
  versao_id TEXT NOT NULL,
  arrolado_id TEXT NOT NULL,
  orgao_id TEXT NOT NULL,
  cargo_id TEXT NOT NULL,
  CONSTRAINT cargo_arrolado_contexto_fkey FOREIGN KEY (arrolado_id, igreja_id, contexto_id, versao_id) REFERENCES arrolado_documento(id, igreja_id, contexto_id, versao_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cargo_arrolado_documento_cargo_id_igreja_id_orgao_id_fkey FOREIGN KEY (cargo_id, igreja_id, orgao_id) REFERENCES cargo_orgao(id, igreja_id, orgao_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX cargo_arrolado_documento_arrolado_id_cargo_id_key ON cargo_arrolado_documento(arrolado_id, cargo_id);
-- Backfill não modifica retratos/conteúdo já congelados.
INSERT INTO cargo_arrolado_documento(id, igreja_id, contexto_id, versao_id, arrolado_id, orgao_id, cargo_id)
  SELECT gen_random_uuid()::text, igreja_id, contexto_id, versao_id, id, orgao_id, cargo_id FROM arrolado_documento WHERE cargo_id IS NOT NULL;
CREATE TRIGGER e04_preservar_cargo_arrolado BEFORE INSERT OR UPDATE OR DELETE ON cargo_arrolado_documento FOR EACH ROW EXECUTE FUNCTION e04_preservar_dependentes();
