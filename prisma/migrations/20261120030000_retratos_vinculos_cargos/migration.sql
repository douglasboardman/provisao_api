ALTER TABLE cargo_orgao ADD COLUMN funcao varchar(40) NOT NULL DEFAULT 'OUTRO';
UPDATE cargo_orgao SET funcao = codigo WHERE codigo IN ('PRESIDENTE', 'VICE_PRESIDENTE', 'SECRETARIO', 'TESOUREIRO', 'LIDER', 'VICE_LIDER');
ALTER TABLE cargo_orgao ADD CONSTRAINT cargo_funcao CHECK (funcao IN ('OUTRO', 'PRESIDENTE', 'VICE_PRESIDENTE', 'SECRETARIO', 'TESOUREIRO', 'LIDER', 'VICE_LIDER'));
ALTER TABLE ocupacao_cargo ADD COLUMN retrato jsonb;
ALTER TABLE membro_orgao ADD COLUMN retrato jsonb;
CREATE FUNCTION congelar_retrato_vinculo_orgao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pessoa jsonb; cargo jsonb;
BEGIN
 SELECT jsonb_build_object('id', p.id, 'nome', p.nome_completo) INTO pessoa FROM pessoas p WHERE p.id = NEW.pessoa_id AND p.igreja_id = NEW.igreja_id;
 IF TG_TABLE_NAME = 'ocupacao_cargo' THEN
  SELECT jsonb_build_object('id', c.id, 'nome', c.nome, 'codigo', c.codigo, 'funcao', c.funcao, 'permite_acumulacao', c.permite_acumulacao,
    'norma', (SELECT a.detalhes FROM ato_orgao a WHERE a.igreja_id = NEW.igreja_id AND a.orgao_id = NEW.orgao_id
     AND a.tipo IN ('CONFIGURACAO_CARGO', 'CONFIGURACAO_ACUMULACAO') AND a.detalhes->>'cargo_id' = c.id ORDER BY a.criado_em DESC, a.id DESC LIMIT 1))
   INTO cargo FROM cargo_orgao c WHERE c.id = NEW.cargo_id AND c.igreja_id = NEW.igreja_id AND c.orgao_id = NEW.orgao_id;
 END IF;
 NEW.retrato := jsonb_build_object('pessoa', pessoa, 'cargo', cargo);
 RETURN NEW;
END $$;
CREATE TRIGGER ocupacao_retrato BEFORE INSERT ON ocupacao_cargo FOR EACH ROW EXECUTE FUNCTION congelar_retrato_vinculo_orgao();
CREATE TRIGGER membro_retrato BEFORE INSERT ON membro_orgao FOR EACH ROW EXECUTE FUNCTION congelar_retrato_vinculo_orgao();
