-- Rename membresia_motivacao_evento values: remove ADM_/DEM_/OUT_ prefixes
-- CARTA_DE_TRANSFERENCIA disambiguated as RECEBIDA (admissão) / CONCEDIDA (demissão)

-- Also update relacao_enum_valores rows that reference the old names
-- (valor_classificador and valor_classificado are plain strings, not enum columns)

ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_PROFISSAO_DE_FE' TO 'PROFISSAO_DE_FE';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_PROFISSAO_DE_FE_E_BATISMO' TO 'PROFISSAO_DE_FE_E_BATISMO';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_CARTA_DE_TRANSFERENCIA' TO 'CARTA_DE_TRANSFERENCIA_RECEBIDA';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_JURISDICAO_A_PEDIDO' TO 'JURISDICAO_A_PEDIDO';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_JURISDICAO_EX_OFFICIO' TO 'JURISDICAO_EX_OFFICIO';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_RESTAURACAO' TO 'RESTAURACAO';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_DESIGNACAO_PRESBITERIO' TO 'DESIGNACAO_PRESBITERIO';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_BATISMO_NA_INFANCIA' TO 'BATISMO_NA_INFANCIA';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_TRANSFERENCIA_PAIS_OU_RESPONSAVEIS' TO 'TRANSFERENCIA_PAIS_OU_RESPONSAVEIS';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'ADM_JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS' TO 'JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_EXCLUSAO_POR_DISCIPLINA' TO 'EXCLUSAO_POR_DISCIPLINA';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_EXCLUSAO_A_PEDIDO' TO 'EXCLUSAO_A_PEDIDO';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_EXCLUSAO_POR_AUSENCIA' TO 'EXCLUSAO_POR_AUSENCIA';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_CARTA_DE_TRANSFERENCIA' TO 'CARTA_DE_TRANSFERENCIA_CONCEDIDA';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_JURISDICAO_ASSUMIDA' TO 'JURISDICAO_ASSUMIDA';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_FALECIMENTO' TO 'FALECIMENTO';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS' TO 'CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_DEZOITO_ANOS_COMPLETOS' TO 'DEZOITO_ANOS_COMPLETOS';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'DEM_SOLICITACAO_PAIS_OUTRA_COMUNIDADE' TO 'SOLICITACAO_PAIS_OUTRA_COMUNIDADE';
ALTER TYPE "membresia_motivacao_evento" RENAME VALUE 'OUT_PARADEIRO_IGNORADO' TO 'PARADEIRO_IGNORADO';

-- Update relacao_enum_valores string columns
UPDATE "relacao_enum_valores" SET "valor_classificador" = REGEXP_REPLACE("valor_classificador", '^ADM_', '')
WHERE "valor_classificador" LIKE 'ADM_%';

UPDATE "relacao_enum_valores" SET "valor_classificador" = REGEXP_REPLACE("valor_classificador", '^DEM_', '')
WHERE "valor_classificador" LIKE 'DEM_%';

UPDATE "relacao_enum_valores" SET "valor_classificador" = REGEXP_REPLACE("valor_classificador", '^OUT_', '')
WHERE "valor_classificador" LIKE 'OUT_%';

UPDATE "relacao_enum_valores" SET "valor_classificado" = REGEXP_REPLACE("valor_classificado", '^ADM_', '')
WHERE "valor_classificado" LIKE 'ADM_%';

UPDATE "relacao_enum_valores" SET "valor_classificado" = REGEXP_REPLACE("valor_classificado", '^DEM_', '')
WHERE "valor_classificado" LIKE 'DEM_%';

UPDATE "relacao_enum_valores" SET "valor_classificado" = REGEXP_REPLACE("valor_classificado", '^OUT_', '')
WHERE "valor_classificado" LIKE 'OUT_%';

-- Handle the CARTA_DE_TRANSFERENCIA disambiguation in relacao_enum_valores
-- ADM_CARTA_DE_TRANSFERENCIA → CARTA_DE_TRANSFERENCIA_RECEBIDA (already stripped to CARTA_DE_TRANSFERENCIA by above)
-- DEM_CARTA_DE_TRANSFERENCIA → CARTA_DE_TRANSFERENCIA_CONCEDIDA (already stripped to CARTA_DE_TRANSFERENCIA by above)
-- We need to identify which is which by checking the rule they belong to

UPDATE "relacao_enum_valores" rev
SET "valor_classificado" = 'CARTA_DE_TRANSFERENCIA_RECEBIDA'
FROM "regras_relacao_enum" rre
WHERE rev."regra_id" = rre."id"
  AND rre."nome" IN ('Motivações de Admissão', 'Rols de Admissão')
  AND rev."valor_classificado" = 'CARTA_DE_TRANSFERENCIA';

UPDATE "relacao_enum_valores" rev
SET "valor_classificado" = 'CARTA_DE_TRANSFERENCIA_CONCEDIDA'
FROM "regras_relacao_enum" rre
WHERE rev."regra_id" = rre."id"
  AND rre."nome" IN ('Motivações de Demissão', 'Rol de Destino por Motivação de Demissão')
  AND rev."valor_classificado" = 'CARTA_DE_TRANSFERENCIA';

UPDATE "relacao_enum_valores" rev
SET "valor_classificador" = 'CARTA_DE_TRANSFERENCIA_RECEBIDA'
FROM "regras_relacao_enum" rre
WHERE rev."regra_id" = rre."id"
  AND rev."valor_classificador" = 'CARTA_DE_TRANSFERENCIA'
  AND rre."nome" IN ('Rols de Admissão');

UPDATE "relacao_enum_valores" rev
SET "valor_classificador" = 'CARTA_DE_TRANSFERENCIA_CONCEDIDA'
FROM "regras_relacao_enum" rre
WHERE rev."regra_id" = rre."id"
  AND rev."valor_classificador" = 'CARTA_DE_TRANSFERENCIA'
  AND rre."nome" IN ('Rol de Destino por Motivação de Demissão', 'Motivações por Rol de Destino');
