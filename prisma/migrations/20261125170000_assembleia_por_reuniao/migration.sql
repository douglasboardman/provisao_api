ALTER TABLE mesa_assembleia
  ADD COLUMN criterio_presidencia jsonb,
  ADD COLUMN votantes_confirmados jsonb,
  ADD CONSTRAINT mesa_votantes_confirmados_array CHECK (votantes_confirmados IS NULL OR jsonb_typeof(votantes_confirmados) = 'array');

ALTER TABLE deliberacao_ata ADD COLUMN conferencia_votacao jsonb;

CREATE INDEX acesso_assembleia_reuniao_mesa_ativo_idx ON acesso_assembleia (igreja_id, reuniao_id, mesa_id)
  WHERE revogado_em IS NULL;
