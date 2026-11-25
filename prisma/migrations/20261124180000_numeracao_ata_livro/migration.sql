BEGIN;
ALTER TABLE documento ADD COLUMN identificacao_livro text;
ALTER TABLE documento DROP CONSTRAINT documento_numero_check,
  ADD CONSTRAINT documento_numero_check CHECK (
    (identificacao_livro IS NULL AND (
      num_nonnulls(numero, ano, sigla) = 0 OR
      (num_nonnulls(numero, ano, sigla) = 3 AND numero > 0 AND ano BETWEEN 1 AND 9999)))
    OR (identificacao_livro IS NOT NULL AND tipo = 'ATA' AND numero IS NOT NULL AND numero > 0 AND ano IS NULL AND sigla IS NULL)
  );

CREATE TABLE contador_ata_livro (
  livro_id text PRIMARY KEY REFERENCES livro_atas(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ultimo integer NOT NULL CHECK (ultimo > 0)
);
CREATE TABLE reserva_ata_livro (
  livro_id text NOT NULL, numero integer NOT NULL CHECK (numero > 0),
  igreja_id text NOT NULL, contexto_id text NOT NULL, documento_id text NOT NULL,
  criado_em timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelada_em timestamp(3), motivo text,
  CHECK ((cancelada_em IS NULL) = (motivo IS NULL)),
  PRIMARY KEY (livro_id, numero),
  FOREIGN KEY (livro_id, igreja_id, contexto_id) REFERENCES livro_atas(id, igreja_id, contexto_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (documento_id, igreja_id, contexto_id) REFERENCES documento(id, igreja_id, contexto_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX reserva_ata_ativa ON reserva_ata_livro(documento_id) WHERE cancelada_em IS NULL;
CREATE INDEX reserva_ata_livro_documento_id_idx ON reserva_ata_livro(documento_id);

-- Cada volume continua após o maior número que já recebeu, inclusive em versões antigas.
INSERT INTO contador_ata_livro (livro_id, ultimo)
SELECT livro_id, max(numero) FROM (
  SELECT v.livro_id, coalesce(d.numero, substring(v.numero_original FROM '(?i)^(?:ata[[:space:]]*)?(?:n[º°.o]?[[:space:]]*)?([0-9]{1,9})(?:[^0-9]|$)')::integer) AS numero
  FROM documento_versao v JOIN documento d ON d.id = v.documento_id
  WHERE v.livro_id IS NOT NULL AND d.tipo = 'ATA'
) historico WHERE numero > 0 GROUP BY livro_id;

CREATE OR REPLACE FUNCTION e04_validar_documento() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.numero IS NOT NULL AND NOT (
    OLD.identificacao_livro IS NOT NULL AND NEW.identificacao_livro IS NOT NULL
    AND OLD.estado = 'EM_EDICAO' AND NEW.estado = 'EM_EDICAO'
    AND (NEW.tipo, NEW.perfil, NEW.contexto_id, NEW.igreja_id) = (OLD.tipo, OLD.perfil, OLD.contexto_id, OLD.igreja_id)
    AND EXISTS (SELECT 1 FROM reserva_ata_livro r WHERE r.documento_id = NEW.id AND r.numero = NEW.numero AND r.cancelada_em IS NULL)
  ) AND
    (NEW.identificacao_livro, NEW.numero, NEW.ano, NEW.sigla, NEW.tipo, NEW.perfil, NEW.contexto_id, NEW.igreja_id) IS DISTINCT FROM
    (OLD.identificacao_livro, OLD.numero, OLD.ano, OLD.sigla, OLD.tipo, OLD.perfil, OLD.contexto_id, OLD.igreja_id) THEN
    RAISE EXCEPTION 'Número reservado e série histórica são imutáveis' USING ERRCODE = '23514';
  END IF;
  IF NEW.estado = 'EXPEDIDO' AND OLD.estado <> 'EXPEDIDO' THEN
    IF OLD.estado <> 'APROVADO' OR NEW.versao_atual <> OLD.versao_atual OR NOT EXISTS (
      SELECT 1 FROM documento_versao v JOIN expedicao_documento e ON e.versao_id = v.id
      WHERE v.documento_id = NEW.id AND v.numero = NEW.versao_atual AND v.congelado_em IS NOT NULL
        AND e.estado = 'CONCLUIDA' AND e.arquivo_final_id IS NOT NULL
        AND (v.livro_id IS NULL OR e.arquivo_livro_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Expedição exige a conclusão do fluxo da versão aprovada' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.estado IN ('EXPEDIDO', 'ANULADO', 'CANCELADO') AND (
    (to_jsonb(NEW) - 'estado' - 'revisao') IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'revisao')
    OR (NEW.estado <> OLD.estado AND NOT (OLD.estado = 'EXPEDIDO' AND NEW.estado = 'ANULADO'))
  ) THEN
    RAISE EXCEPTION 'Documento finalizado não admite edição' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
