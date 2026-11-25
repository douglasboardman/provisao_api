BEGIN;
ALTER TABLE atribuicao_servico DROP CONSTRAINT atribuicao_servico_acao_check,
  ADD CHECK (acao IN ('PESSOAS_CONSULTAR','PESSOAS_CADASTRAR','USUARIOS_CONSULTAR','AUDITORIA_CONSULTAR','PRESIDENCIA_CONFERIR','MANDATOS_REGISTRAR'));
ALTER TABLE mandato_oficial
  ADD COLUMN orgao_id text,
  ADD COLUMN versao_orgao_id text,
  ADD COLUMN chave_registro text,
  ADD COLUMN hash_registro text,
  ADD CONSTRAINT mandato_versao_orgao_fkey FOREIGN KEY (versao_orgao_id, igreja_id, orgao_id)
    REFERENCES versao_orgao(id, igreja_id, orgao_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CHECK (num_nonnulls(orgao_id, versao_orgao_id, chave_registro, hash_registro) IN (0,4)),
  ADD UNIQUE (igreja_id, chave_registro);
COMMIT;
