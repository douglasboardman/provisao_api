-- Migration: garante no banco que uma pessoa só pode ter UM vínculo ativo por vez.
--
-- PostgreSQL suporta partial/filtered indexes nativamente, o que é a solução
-- ideal: cria um UNIQUE INDEX sobre pessoa_id APENAS quando vinculo_ativo = TRUE.
-- Registros inativos (vinculo_ativo = FALSE) são ignorados pela constraint.

CREATE UNIQUE INDEX "vinculos_membresia_pessoa_ativo_UNIQUE"
  ON "vinculos_membresia" ("pessoa_id")
  WHERE "vinculo_ativo" = TRUE;
