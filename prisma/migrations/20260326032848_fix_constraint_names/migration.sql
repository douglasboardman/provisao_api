-- RenameIndex
ALTER INDEX "tipo_despesa_id" RENAME TO "descritivos_despesa_tipo_despesa_id";

-- RenameIndex
ALTER INDEX "tipo_receita_id" RENAME TO "descritivos_receita_tipo_receita_id";

-- RenameIndex
ALTER INDEX "responsavel_pessoa_id" RENAME TO "destinacoes_responsavel_pessoa_id";

-- RenameIndex
ALTER INDEX "cpf_UNIQUE" RENAME TO "pessoas_cpf_UNIQUE";

-- RenameIndex
ALTER INDEX "email_UNIQUE" RENAME TO "pessoas_email_UNIQUE";

-- RenameIndex
ALTER INDEX "grupo_familiar_id" RENAME TO "pessoas_grupo_familiar_id";

-- RenameIndex
ALTER INDEX "email_login_UNIQUE" RENAME TO "usuarios_email_login_UNIQUE";

-- RenameIndex
ALTER INDEX "nome_usuario_UNIQUE" RENAME TO "usuarios_nome_usuario_UNIQUE";
