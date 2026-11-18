-- Aditiva: preservar limites civis dos registros anteriores.
ALTER TABLE membro_orgao ADD COLUMN inicio_ordem integer NOT NULL DEFAULT 1, ADD COLUMN fim_ordem integer;
UPDATE membro_orgao SET fim_ordem = 1 WHERE fim IS NOT NULL;
ALTER TABLE membro_orgao DROP CONSTRAINT membro_orgao_periodo;
ALTER TABLE membro_orgao DROP CONSTRAINT membro_orgao_sem_sobreposicao;
ALTER TABLE membro_orgao ADD CONSTRAINT membro_orgao_periodo CHECK (
 inicio_ordem BETWEEN 1 AND 9999 AND
 ((fim IS NULL AND fim_ordem IS NULL) OR
 (fim IS NOT NULL AND fim_ordem IS NOT NULL AND fim_ordem BETWEEN 1 AND 9999 AND (fim > inicio OR (fim = inicio AND fim_ordem > inicio_ordem))))
);
ALTER TABLE membro_orgao ADD CONSTRAINT membro_orgao_sem_sobreposicao EXCLUDE USING gist (
 orgao_id WITH =, pessoa_id WITH =,
 int8range((inicio - DATE '2000-01-01')::bigint * 10000 + inicio_ordem,
 (fim - DATE '2000-01-01')::bigint * 10000 + fim_ordem, '[)') WITH &&
);
ALTER TABLE ato_orgao ADD COLUMN retrato jsonb;
-- Sem backfill de nomes: o estado atual não prova a identificação histórica.
CREATE FUNCTION congelar_retrato_ato_orgao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT jsonb_build_object('orgao', jsonb_build_object('id', o.id, 'nome', o.nome, 'sigla', o.sigla, 'tipo', o.tipo, 'constituicao', o.constituicao),
 'operador', jsonb_build_object('id', u.id, 'nome', u.nome_usuario),
 'pessoas', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'nome', p.nome_completo) ORDER BY p.id) FROM pessoas p
 WHERE p.igreja_id = NEW.igreja_id AND (p.id = NEW.autoridade OR p.id IN (
 SELECT c.pessoa_id FROM ocupacao_cargo c WHERE c.igreja_id = NEW.igreja_id AND c.id IN (NEW.detalhes->>'ocupacao_id', NEW.detalhes->>'nova_id', NEW.detalhes->>'anterior_id')
 UNION SELECT m.pessoa_id FROM membro_orgao m WHERE m.igreja_id = NEW.igreja_id AND m.id = NEW.detalhes->>'membro_id'
 UNION SELECT NEW.detalhes->>'pessoa_id'))), '[]'::jsonb),
 'cargo', (SELECT jsonb_build_object('id', c.id, 'nome', c.nome, 'codigo', c.codigo, 'permite_acumulacao', c.permite_acumulacao)
 FROM cargo_orgao c WHERE c.igreja_id = NEW.igreja_id AND c.orgao_id = NEW.orgao_id AND c.id = NEW.detalhes->>'cargo_id')) INTO NEW.retrato
 FROM orgao_interno o, usuarios u WHERE o.id = NEW.orgao_id AND o.igreja_id = NEW.igreja_id AND u.id = NEW.operador_id AND u.igreja_id = NEW.igreja_id;
 RETURN NEW;
END $$;
CREATE TRIGGER ato_orgao_retrato BEFORE INSERT ON ato_orgao FOR EACH ROW EXECUTE FUNCTION congelar_retrato_ato_orgao();
CREATE TABLE conducao_reuniao_orgao (
 id text PRIMARY KEY, igreja_id text NOT NULL, orgao_id text NOT NULL, pessoa_id text NOT NULL,
 referencia varchar(255) NOT NULL, data_reuniao date NOT NULL, motivo varchar(1000) NOT NULL,
 FOREIGN KEY (orgao_id, igreja_id) REFERENCES orgao_interno(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY (pessoa_id, igreja_id) REFERENCES pessoas(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 UNIQUE (orgao_id, referencia)
);
