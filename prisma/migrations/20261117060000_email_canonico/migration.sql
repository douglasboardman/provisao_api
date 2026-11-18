-- Falha sem alterar dados se o legado exigir conferência humana.
DO $$
DECLARE contas INTEGER; pedidos INTEGER;
BEGIN
  SELECT count(*) INTO contas FROM (SELECT 1 FROM usuarios GROUP BY igreja_id, lower(btrim(email_login)) HAVING count(*) > 1) conflitos;
  SELECT count(*) INTO pedidos FROM (SELECT 1 FROM solicitacao_acesso WHERE estado IN ('AGUARDA_CONFIRMACAO','EM_ANALISE') GROUP BY igreja_id, lower(btrim(email_login)) HAVING count(*) > 1) conflitos;
  IF contas > 0 OR pedidos > 0 THEN
    RAISE EXCEPTION 'Colisões de e-mail por igreja: % grupos de contas e % grupos de solicitações; conferir antes da migração.', contas, pedidos;
  END IF;
END $$;
CREATE UNIQUE INDEX "usuarios_igreja_email_canonico_key" ON "usuarios" ("igreja_id", lower(btrim("email_login")));
CREATE UNIQUE INDEX "solicitacao_igreja_email_canonico_pendente_key" ON "solicitacao_acesso" ("igreja_id", lower(btrim("email_login"))) WHERE "estado" IN ('AGUARDA_CONFIRMACAO','EM_ANALISE');
