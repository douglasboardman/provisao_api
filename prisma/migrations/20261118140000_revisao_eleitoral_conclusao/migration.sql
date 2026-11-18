ALTER TABLE revisao_eleitoral_item
 ADD COLUMN revisado_por_id TEXT,
 ADD COLUMN autoridade_revisao VARCHAR(255),
 ADD COLUMN evidencia_revisao VARCHAR(1000),
 ADD COLUMN conclusao_revisao VARCHAR(1000),
 ADD COLUMN permite_reutilizacao BOOLEAN,
 ADD CONSTRAINT revisao_item_responsavel_fk FOREIGN KEY (revisado_por_id, igreja_id) REFERENCES usuarios(id, igreja_id) ON DELETE RESTRICT,
 ADD CONSTRAINT revisao_item_conclusao_coerente CHECK (
  (revisado_em IS NULL AND revisado_por_id IS NULL AND autoridade_revisao IS NULL AND evidencia_revisao IS NULL AND conclusao_revisao IS NULL AND permite_reutilizacao IS NULL)
  OR (revisado_em IS NOT NULL AND revisado_por_id IS NOT NULL AND autoridade_revisao IS NOT NULL AND evidencia_revisao IS NOT NULL AND conclusao_revisao IS NOT NULL AND length(btrim(autoridade_revisao)) > 0 AND length(btrim(evidencia_revisao)) > 0 AND length(btrim(conclusao_revisao)) > 0 AND permite_reutilizacao IS NOT NULL)
 );
