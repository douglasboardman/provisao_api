BEGIN;
ALTER TYPE usuarios_perfil ADD VALUE 'COMUM';
ALTER TABLE usuarios ADD COLUMN conta_atuacao boolean NOT NULL DEFAULT false,
  ADD COLUMN geracao_vinculo integer NOT NULL DEFAULT 0,
  ADD CHECK (NOT conta_atuacao OR (pessoa_id IS NOT NULL AND ativo AND perfil::text NOT IN ('AUDITOR','ADMINISTRADOR')));
CREATE UNIQUE INDEX usuarios_atuacao_por_pessoa ON usuarios(igreja_id,pessoa_id) WHERE conta_atuacao;

-- Uma atribuição da identidade anterior não volta a valer ao refazer o vínculo.
CREATE FUNCTION invalidar_atuacao_conta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.pessoa_id, NEW.igreja_id, NEW.perfil, NEW.ativo) IS DISTINCT FROM
     (OLD.pessoa_id, OLD.igreja_id, OLD.perfil, OLD.ativo) THEN
    NEW.conta_atuacao := false;
    NEW.geracao_vinculo := OLD.geracao_vinculo + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invalidar_atuacao_conta BEFORE UPDATE OF pessoa_id,igreja_id,perfil,ativo ON usuarios
  FOR EACH ROW EXECUTE FUNCTION invalidar_atuacao_conta();

CREATE TABLE atribuicao_servico (
  id text PRIMARY KEY, igreja_id text NOT NULL, usuario_id text NOT NULL, pessoa_id text NOT NULL, geracao_vinculo integer NOT NULL,
  acao text NOT NULL CHECK (acao IN ('PESSOAS_CONSULTAR','PESSOAS_CADASTRAR','USUARIOS_CONSULTAR','AUDITORIA_CONSULTAR','PRESIDENCIA_CONFERIR')),
  inicio timestamptz(3) NOT NULL, fim timestamptz(3), revogado_em timestamptz(3),
  FOREIGN KEY (usuario_id,igreja_id) REFERENCES usuarios(id,igreja_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (fim IS NULL OR fim > inicio),
  EXCLUDE USING gist (usuario_id WITH =, geracao_vinculo WITH =, acao WITH =, tstzrange(inicio,fim,'[)') WITH &&) WHERE (revogado_em IS NULL)
);
CREATE INDEX atribuicao_servico_igreja_id_usuario_id_idx ON atribuicao_servico(igreja_id,usuario_id);

CREATE TABLE evento_autorizacao (
  id text PRIMARY KEY, igreja_id text NOT NULL, operador_id text NOT NULL, operador_pessoa_id text,
  destinatario_id text, pessoa_id text, acao text NOT NULL, recurso_id text, fundamento text NOT NULL,
  dados jsonb NOT NULL, instante timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX evento_autorizacao_igreja_id_instante_idx ON evento_autorizacao(igreja_id,instante);
CREATE UNIQUE INDEX conferencia_presidencia_unica ON evento_autorizacao(igreja_id,recurso_id,acao)
  WHERE acao IN ('PRESIDENCIA_ENCAMINHADA','PRESIDENCIA_CONFERIDA');
CREATE FUNCTION preservar_evento_autorizacao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Evento de autorização é imutável' USING ERRCODE='23514';
END $$;
CREATE TRIGGER preservar_evento_autorizacao BEFORE UPDATE OR DELETE ON evento_autorizacao
  FOR EACH ROW EXECUTE FUNCTION preservar_evento_autorizacao();
COMMIT;
