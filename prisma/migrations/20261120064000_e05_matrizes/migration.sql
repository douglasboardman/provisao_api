ALTER TABLE "trabalho_renderizacao"
  ADD COLUMN "finalidade" VARCHAR(20) NOT NULL DEFAULT 'RASCUNHO',
  ADD COLUMN "executar_apos" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "trabalho_renderizacao_usuario_id_igreja_id_fkey"
    FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "trabalho_renderizacao_finalidade_check"
    CHECK ("finalidade" IN ('RASCUNHO', 'MATRIZ_APROVADA')),
  ADD CONSTRAINT "trabalho_renderizacao_resultado_check"
    CHECK (("estado" = 'CONCLUIDO') = ("arquivo_id" IS NOT NULL)),
  ADD CONSTRAINT "trabalho_renderizacao_reserva_check"
    CHECK (("estado" = 'PROCESSANDO' AND "reserva_id" IS NOT NULL AND "reserva_ate" IS NOT NULL)
      OR ("estado" <> 'PROCESSANDO' AND "reserva_id" IS NULL AND "reserva_ate" IS NULL));

CREATE UNIQUE INDEX "trabalho_renderizacao_arquivo_id_key" ON "trabalho_renderizacao" ("arquivo_id");
CREATE UNIQUE INDEX "trabalho_renderizacao_matriz_versao_key" ON "trabalho_renderizacao" ("versao_id")
  WHERE "finalidade" = 'MATRIZ_APROVADA';

CREATE FUNCTION proteger_trabalho_renderizacao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado = 'CONCLUIDO' THEN RAISE EXCEPTION 'Artefato arquivado é imutável'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.estado = 'CONCLUIDO'
    OR ROW(NEW.id, NEW.igreja_id, NEW.contexto_id, NEW.versao_id, NEW.revisao_documento, NEW.usuario_id, NEW.fonte, NEW.finalidade, NEW.criado_em)
       IS DISTINCT FROM ROW(OLD.id, OLD.igreja_id, OLD.contexto_id, OLD.versao_id, OLD.revisao_documento, OLD.usuario_id, OLD.fonte, OLD.finalidade, OLD.criado_em)) THEN
    RAISE EXCEPTION 'Fonte ou artefato de renderização é imutável';
  END IF;
  IF NEW.finalidade = 'MATRIZ_APROVADA' AND NOT EXISTS (
    SELECT 1 FROM documento_versao v WHERE v.id = NEW.versao_id AND v.igreja_id = NEW.igreja_id
      AND v.contexto_id = NEW.contexto_id AND v.congelado_em IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Matriz exige versão congelada';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proteger_trabalho_renderizacao BEFORE INSERT OR UPDATE OR DELETE ON trabalho_renderizacao
FOR EACH ROW EXECUTE FUNCTION proteger_trabalho_renderizacao();

CREATE FUNCTION proteger_arquivo_artefato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trabalho_renderizacao WHERE arquivo_id = OLD.id) THEN
    RAISE EXCEPTION 'Metadados do artefato arquivado são imutáveis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proteger_arquivo_artefato BEFORE UPDATE ON arquivo_privado
FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION proteger_arquivo_artefato();
