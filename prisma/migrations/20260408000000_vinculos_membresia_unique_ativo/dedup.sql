-- Desativa o vínculo mais recente de cada pessoa que tem dois vínculos ativos,
-- mantendo apenas o mais antigo como ativo.
UPDATE vinculos_membresia
SET vinculo_ativo = FALSE
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY pessoa_id ORDER BY created_at ASC) AS rn
    FROM vinculos_membresia
    WHERE vinculo_ativo = TRUE
  ) ranked
  WHERE rn > 1
);
