CREATE TABLE liberacao_servico (
  igreja_id text NOT NULL REFERENCES igreja(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  acao text NOT NULL CHECK (acao IN (
    'PESSOAS_CONSULTAR', 'PESSOAS_CADASTRAR', 'PESSOAS_EDITAR', 'PESSOAS_EXCLUIR',
    'FAMILIAS_CONSULTAR', 'FAMILIAS_CADASTRAR', 'FAMILIAS_EDITAR', 'FAMILIAS_EXCLUIR',
    'MEMBRESIA_CONSULTAR', 'MEMBRESIA_REGISTRAR', 'MEMBRESIA_EDITAR', 'MEMBRESIA_EXCLUIR',
    'LANCAMENTOS_CONSULTAR', 'LANCAMENTOS_REGISTRAR', 'LANCAMENTOS_EDITAR', 'LANCAMENTOS_EXCLUIR',
    'BALANCO_CONSULTAR', 'AUDITORIA_CONSULTAR', 'MANDATOS_REGISTRAR'
  )),
  estado text NOT NULL CHECK (estado IN ('ATRIBUICAO', 'PAUSADO')),
  revisao integer NOT NULL CHECK (revisao > 0),
  PRIMARY KEY (igreja_id, acao)
);

CREATE FUNCTION preservar_liberacao_servico() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Uma operação liberada deve conservar sua política de corte' USING ERRCODE = '23514';
  END IF;
  IF (NEW.igreja_id, NEW.acao) IS DISTINCT FROM (OLD.igreja_id, OLD.acao) OR NEW.revisao <> OLD.revisao + 1 THEN
    RAISE EXCEPTION 'Escopo ou revisão da liberação inválidos' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER preservar_liberacao_servico
  BEFORE UPDATE OR DELETE ON liberacao_servico FOR EACH ROW EXECUTE FUNCTION preservar_liberacao_servico();
