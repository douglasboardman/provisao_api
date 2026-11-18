BEGIN;

-- CreateEnum
CREATE TYPE "livro_estado" AS ENUM ('EM_PREPARACAO', 'ABERTO', 'SUSPENSO', 'EM_ENCERRAMENTO', 'ENCERRADO');

-- CreateEnum
CREATE TYPE "livro_modalidade" AS ENUM ('PARA_ENCADERNACAO', 'ELETRONICO', 'FISICO_DIGITALIZADO');

-- CreateEnum
CREATE TYPE "registro_livro_estado" AS ENUM ('RESERVADO', 'EFETIVADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "registro_livro_natureza" AS ENUM ('ABERTURA', 'ATA_ORIGINAL', 'EXAME', 'OUTRO_AUTORIZADO', 'ENCERRAMENTO');

-- AlterTable
ALTER TABLE "documento_versao" ADD COLUMN     "livro_id" TEXT;

-- AlterTable
ALTER TABLE "trabalho_renderizacao" ADD COLUMN "paginas_medidas" INTEGER, ADD COLUMN "medicao_revisao" INTEGER;

-- CreateTable
CREATE TABLE "livro_atas" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "titular" VARCHAR(255) NOT NULL,
    "serie" VARCHAR(80) NOT NULL,
    "numero" INTEGER NOT NULL,
    "modalidade" "livro_modalidade" NOT NULL,
    "perfil" VARCHAR(40) NOT NULL,
    "capacidade_folhas" INTEGER NOT NULL,
    "faces_por_folha" INTEGER NOT NULL,
    "reserva_exame" INTEGER NOT NULL,
    "fonte_normativa" VARCHAR(1000) NOT NULL,
    "restrito" BOOLEAN NOT NULL,
    "estado" "livro_estado" NOT NULL DEFAULT 'EM_PREPARACAO',
    "revisao" INTEGER NOT NULL DEFAULT 1,
    "motivo_encerramento" VARCHAR(1000),
    "aberto_em" TIMESTAMP(3),
    "encerrado_em" TIMESTAMP(3),
    "manifesto" JSONB,
    "manifesto_sha256" CHAR(64),
    "arquivo_historico_id" TEXT,
    "data_historica" DATE,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "livro_atas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registro_livro" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "livro_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "natureza" "registro_livro_natureza" NOT NULL,
    "estado" "registro_livro_estado" NOT NULL DEFAULT 'RESERVADO',
    "ordem" INTEGER NOT NULL,
    "posicao_inicio" INTEGER NOT NULL,
    "posicao_fim" INTEGER NOT NULL,
    "numero_visivel_inicio" INTEGER,
    "arquivo_id" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "efetivado_em" TIMESTAMP(3),
    "cancelado_em" TIMESTAMP(3),

    CONSTRAINT "registro_livro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evento_livro" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "livro_id" TEXT NOT NULL,
    "operador_id" TEXT NOT NULL,
    "tipo" VARCHAR(40) NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" VARCHAR(1000) NOT NULL,
    "motivo" VARCHAR(1000) NOT NULL,
    "retrato" JSONB NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evento_livro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complemento_livro" (
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "livro_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complemento_livro_pkey" PRIMARY KEY ("livro_id","versao_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "livro_atas_id_igreja_id_contexto_id_key" ON "livro_atas"("id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "livro_atas_igreja_id_contexto_id_serie_numero_key" ON "livro_atas"("igreja_id", "contexto_id", "serie", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "registro_livro_versao_id_key" ON "registro_livro"("versao_id");

-- CreateIndex
CREATE UNIQUE INDEX "registro_livro_versao_id_igreja_id_contexto_id_key" ON "registro_livro"("versao_id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "registro_livro_livro_id_ordem_key" ON "registro_livro"("livro_id", "ordem");

-- CreateIndex
CREATE INDEX "evento_livro_livro_id_criado_em_idx" ON "evento_livro"("livro_id", "criado_em");

-- AddForeignKey
ALTER TABLE "documento_versao" ADD CONSTRAINT "versao_livro_fkey" FOREIGN KEY ("livro_id", "igreja_id", "contexto_id") REFERENCES "livro_atas"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "livro_atas" ADD CONSTRAINT "livro_atas_contexto_id_igreja_id_fkey" FOREIGN KEY ("contexto_id", "igreja_id") REFERENCES "contexto_secretaria"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "livro_atas" ADD CONSTRAINT "livro_arquivo_historico_fkey" FOREIGN KEY ("arquivo_historico_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "registro_livro" ADD CONSTRAINT "registro_livro_livro_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("livro_id", "igreja_id", "contexto_id") REFERENCES "livro_atas"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "registro_livro" ADD CONSTRAINT "registro_livro_versao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "registro_livro" ADD CONSTRAINT "registro_livro_arquivo_id_igreja_id_fkey" FOREIGN KEY ("arquivo_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "evento_livro" ADD CONSTRAINT "evento_livro_livro_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("livro_id", "igreja_id", "contexto_id") REFERENCES "livro_atas"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "evento_livro" ADD CONSTRAINT "evento_livro_operador_id_igreja_id_fkey" FOREIGN KEY ("operador_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "complemento_livro" ADD CONSTRAINT "complemento_livro_livro_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("livro_id", "igreja_id", "contexto_id") REFERENCES "livro_atas"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "complemento_livro" ADD CONSTRAINT "complemento_livro_versao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE trabalho_renderizacao
  DROP CONSTRAINT trabalho_renderizacao_finalidade_check,
  DROP CONSTRAINT trabalho_renderizacao_resultado_check,
  ADD CONSTRAINT trabalho_renderizacao_finalidade_check
    CHECK (finalidade IN ('RASCUNHO', 'MATRIZ_APROVADA', 'MEDICAO_LIVRO')),
  ADD CONSTRAINT trabalho_renderizacao_resultado_check CHECK (
    (arquivo_id IS NOT NULL) = (estado = 'CONCLUIDO' AND finalidade <> 'MEDICAO_LIVRO')
    AND (paginas_medidas IS NOT NULL) = (estado = 'CONCLUIDO' AND finalidade = 'MEDICAO_LIVRO')
    AND (paginas_medidas IS NULL OR paginas_medidas > 0)
  ),
  ADD CONSTRAINT trabalho_renderizacao_revisao_medicao_check
    CHECK ((revisao_documento < 0) = (finalidade = 'MEDICAO_LIVRO')
      AND (medicao_revisao IS NOT NULL) = (finalidade = 'MEDICAO_LIVRO') AND (medicao_revisao IS NULL OR medicao_revisao > 0));

ALTER TABLE livro_atas ADD CONSTRAINT livro_capacidade_check CHECK (
  numero > 0 AND revisao > 0 AND capacidade_folhas BETWEEN 1 AND 1000
  AND faces_por_folha IN (1, 2) AND reserva_exame >= 0
  AND (modalidade = 'FISICO_DIGITALIZADO' OR capacidade_folhas * faces_por_folha >= 2 + reserva_exame)
  AND (perfil <> 'CONCILIO_IPB_2025' OR
    (modalidade = 'PARA_ENCADERNACAO' AND capacidade_folhas BETWEEN 50 AND 100))
);
ALTER TABLE livro_atas ADD CONSTRAINT livro_formalizacao_check CHECK (
  (modalidade = 'FISICO_DIGITALIZADO' AND estado = 'ENCERRADO'
    AND aberto_em IS NULL AND encerrado_em IS NULL AND manifesto IS NULL AND manifesto_sha256 IS NULL
    AND data_historica IS NOT NULL AND arquivo_historico_id IS NOT NULL)
  OR
  (modalidade <> 'FISICO_DIGITALIZADO' AND data_historica IS NULL AND arquivo_historico_id IS NULL
    AND (aberto_em IS NULL) = (estado = 'EM_PREPARACAO')
    AND (encerrado_em IS NOT NULL) = (estado = 'ENCERRADO')
    AND (manifesto IS NOT NULL) = (estado = 'ENCERRADO')
    AND (manifesto_sha256 IS NOT NULL) = (estado = 'ENCERRADO')
    AND (motivo_encerramento IS NOT NULL) = (estado IN ('EM_ENCERRAMENTO', 'ENCERRADO')))
);
ALTER TABLE registro_livro ADD CONSTRAINT registro_livro_posicao_check CHECK (
  ordem > 0 AND posicao_inicio > 0 AND posicao_fim >= posicao_inicio AND
  CASE WHEN natureza IN ('ABERTURA', 'ENCERRAMENTO')
    THEN numero_visivel_inicio IS NULL AND posicao_inicio = posicao_fim
    ELSE posicao_inicio > 1 AND numero_visivel_inicio IS NOT NULL AND numero_visivel_inicio = posicao_inicio - 1
  END
);
ALTER TABLE registro_livro ADD CONSTRAINT registro_livro_estado_check CHECK (
  (arquivo_id IS NOT NULL) = (estado = 'EFETIVADO')
  AND (efetivado_em IS NOT NULL) = (estado = 'EFETIVADO')
  AND (cancelado_em IS NOT NULL) = (estado = 'CANCELADO')
);

CREATE UNIQUE INDEX registro_livro_termo_ativo_key ON registro_livro (livro_id, natureza)
  WHERE natureza IN ('ABERTURA', 'ENCERRAMENTO') AND estado <> 'CANCELADO';
CREATE INDEX documento_versao_livro_idx ON documento_versao (livro_id) WHERE livro_id IS NOT NULL;

CREATE FUNCTION e06_proteger_livro() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Livro pertence ao acervo' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'EM_PREPARACAO' AND NEW.modalidade <> 'FISICO_DIGITALIZADO' THEN
      RAISE EXCEPTION 'Livro novo deve estar em preparação' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.estado = 'ENCERRADO' OR
    (to_jsonb(NEW) - ARRAY['estado','revisao','aberto_em','encerrado_em','motivo_encerramento','manifesto','manifesto_sha256'])
      IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['estado','revisao','aberto_em','encerrado_em','motivo_encerramento','manifesto','manifesto_sha256'])
    OR (OLD.aberto_em IS NOT NULL AND NEW.aberto_em IS DISTINCT FROM OLD.aberto_em) THEN
    RAISE EXCEPTION 'Dados históricos do livro são imutáveis' USING ERRCODE = '23514';
  END IF;
  IF NEW.estado = OLD.estado THEN RETURN NEW; END IF;
  IF (OLD.estado, NEW.estado) IN (('EM_PREPARACAO', 'ABERTO'), ('ABERTO', 'SUSPENSO'),
      ('SUSPENSO', 'ABERTO'), ('ABERTO', 'EM_ENCERRAMENTO'), ('SUSPENSO', 'EM_ENCERRAMENTO'),
      ('EM_ENCERRAMENTO', 'ABERTO'), ('EM_ENCERRAMENTO', 'ENCERRADO')) THEN
    IF OLD.estado = 'EM_PREPARACAO' AND NOT EXISTS (
      SELECT 1 FROM registro_livro WHERE livro_id = NEW.id AND natureza = 'ABERTURA' AND estado = 'EFETIVADO'
    ) THEN RAISE EXCEPTION 'Abertura exige termo expedido' USING ERRCODE = '23514'; END IF;
    IF NEW.estado IN ('EM_ENCERRAMENTO', 'ENCERRADO') AND EXISTS (
      SELECT 1 FROM registro_livro WHERE livro_id = NEW.id AND estado = 'RESERVADO'
    ) THEN RAISE EXCEPTION 'Livro tem reservas pendentes' USING ERRCODE = '23514'; END IF;
    IF NEW.estado = 'ENCERRADO' AND NOT EXISTS (
      SELECT 1 FROM registro_livro WHERE livro_id = NEW.id AND natureza = 'ENCERRAMENTO' AND estado = 'EFETIVADO'
    ) THEN RAISE EXCEPTION 'Encerramento exige termo expedido' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Transição de livro inválida' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER e06_proteger_livro BEFORE INSERT OR UPDATE OR DELETE ON livro_atas
FOR EACH ROW EXECUTE FUNCTION e06_proteger_livro();

CREATE FUNCTION e06_proteger_registro() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF versao.livro_id IS DISTINCT FROM NEW.livro_id OR versao.restrito <> livro.restrito
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
CREATE TRIGGER e06_proteger_registro BEFORE INSERT OR UPDATE OR DELETE ON registro_livro
FOR EACH ROW EXECUTE FUNCTION e06_proteger_registro();

CREATE TRIGGER e06_evento_imutavel BEFORE UPDATE OR DELETE ON evento_livro
FOR EACH ROW EXECUTE FUNCTION e04_versao_modelo_imutavel();
CREATE TRIGGER e06_complemento_imutavel BEFORE UPDATE OR DELETE ON complemento_livro
FOR EACH ROW EXECUTE FUNCTION e04_versao_modelo_imutavel();

CREATE OR REPLACE FUNCTION proteger_arquivo_artefato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trabalho_renderizacao WHERE arquivo_id = OLD.id)
    OR EXISTS (SELECT 1 FROM livro_atas WHERE arquivo_historico_id = OLD.id)
    OR EXISTS (SELECT 1 FROM registro_livro WHERE arquivo_id = OLD.id) THEN
    RAISE EXCEPTION 'Metadados do artefato arquivado são imutáveis';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION proteger_trabalho_renderizacao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado = 'CONCLUIDO' THEN RAISE EXCEPTION 'Artefato arquivado é imutável'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.estado = 'CONCLUIDO'
    OR ROW(NEW.id, NEW.igreja_id, NEW.contexto_id, NEW.versao_id, NEW.revisao_documento, NEW.medicao_revisao, NEW.usuario_id, NEW.fonte, NEW.finalidade, NEW.criado_em)
       IS DISTINCT FROM ROW(OLD.id, OLD.igreja_id, OLD.contexto_id, OLD.versao_id, OLD.revisao_documento, OLD.medicao_revisao, OLD.usuario_id, OLD.fonte, OLD.finalidade, OLD.criado_em)) THEN
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

COMMIT;
