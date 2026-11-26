BEGIN;

CREATE OR REPLACE FUNCTION e04_validar_documento() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Classificar a ata altera apenas o controle de acesso e a revisão otimista.
  IF OLD.tipo = 'ATA' AND NEW.restrito IS DISTINCT FROM OLD.restrito AND NEW.revisao = OLD.revisao + 1
    AND (to_jsonb(NEW) - ARRAY['restrito','revisao']) = (to_jsonb(OLD) - ARRAY['restrito','revisao']) THEN
    RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION e06_proteger_registro() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  livro livro_atas%ROWTYPE;
  versao RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Registro de livro pertence ao acervo' USING ERRCODE = '23514';
  END IF;
  -- A escrita no pai serializa ocupação concorrente mesmo em REPEATABLE READ.
  UPDATE livro_atas SET revisao = revisao + 1 WHERE id = NEW.livro_id RETURNING * INTO STRICT livro;
  SELECT v.livro_id, v.congelado_em, m.finalidade, d.tipo, d.perfil, d.restrito, d.estado, d.versao_atual, v.numero
    INTO STRICT versao
    FROM documento_versao v JOIN documento d ON d.id = v.documento_id
      JOIN modelo_documento_versao m ON m.id = v.modelo_versao_id
    WHERE v.id = NEW.versao_id;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.estado <> 'RESERVADO' OR NEW.estado NOT IN ('CANCELADO', 'EFETIVADO') OR
      (to_jsonb(NEW) - ARRAY['estado','arquivo_id','efetivado_em','cancelado_em']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['estado','arquivo_id','efetivado_em','cancelado_em']) THEN
      RAISE EXCEPTION 'Posição e histórico do registro são imutáveis' USING ERRCODE = '23514';
    END IF;
    IF NEW.estado = 'EFETIVADO' AND (versao.estado <> 'EXPEDIDO' OR versao.numero <> versao.versao_atual OR versao.congelado_em IS NULL) THEN
      RAISE EXCEPTION 'Registro exige a versão expedida' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF versao.livro_id IS DISTINCT FROM NEW.livro_id OR (versao.tipo <> 'ATA' AND versao.restrito <> livro.restrito)
    OR NEW.estado <> 'RESERVADO' OR NEW.posicao_fim > livro.capacidade_folhas * livro.faces_por_folha
    OR NOT (CASE NEW.natureza
      WHEN 'ABERTURA' THEN versao.tipo = 'OUTRO' AND versao.finalidade = 'TERMO_ABERTURA' AND livro.estado = 'EM_PREPARACAO' AND NEW.posicao_inicio = 1
      WHEN 'ENCERRAMENTO' THEN versao.tipo = 'OUTRO' AND versao.finalidade = 'TERMO_ENCERRAMENTO' AND livro.estado = 'EM_ENCERRAMENTO'
      WHEN 'ATA_ORIGINAL' THEN versao.tipo = 'ATA' AND versao.perfil = livro.serie AND livro.estado = 'ABERTO'
      WHEN 'EXAME' THEN versao.tipo = 'OUTRO' AND versao.finalidade = 'TERMO_EXAME' AND livro.estado = 'ABERTO'
      WHEN 'OUTRO_AUTORIZADO' THEN versao.tipo = 'OUTRO' AND versao.finalidade NOT IN ('TERMO_ABERTURA','TERMO_ENCERRAMENTO','TERMO_EXAME') AND livro.estado = 'ABERTO'
    END)
    OR EXISTS (SELECT 1 FROM registro_livro r WHERE r.livro_id = NEW.livro_id
      AND r.posicao_inicio <= NEW.posicao_fim AND r.posicao_fim >= NEW.posicao_inicio
      AND (r.estado <> 'CANCELADO' OR r.natureza NOT IN ('ABERTURA', 'ENCERRAMENTO')))
  THEN RAISE EXCEPTION 'Registro incompatível ou posição ocupada' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

COMMIT;
