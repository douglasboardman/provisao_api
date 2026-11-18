-- Somente contagens; executar apenas em banco autorizado, sem imprimir endereços.
SELECT 'usuarios' AS origem, count(*) AS grupos_em_conflito
FROM (SELECT 1 FROM usuarios GROUP BY igreja_id, lower(btrim(email_login)) HAVING count(*) > 1) conflitos
UNION ALL
SELECT 'solicitacoes_pendentes', count(*)
FROM (SELECT 1 FROM solicitacao_acesso WHERE estado IN ('AGUARDA_CONFIRMACAO','EM_ANALISE') GROUP BY igreja_id, lower(btrim(email_login)) HAVING count(*) > 1) conflitos;
