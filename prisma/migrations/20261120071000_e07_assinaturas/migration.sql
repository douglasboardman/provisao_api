BEGIN;

-- CreateEnum
CREATE TYPE "modalidade_assinatura" AS ENUM ('ELETRONICA', 'FISICA');

-- CreateEnum
CREATE TYPE "estado_expedicao" AS ENUM ('AGUARDANDO', 'PENDENTE', 'PROCESSANDO', 'FALHOU', 'CONCLUIDA', 'CANCELADA');

-- AlterTable
ALTER TABLE "outbox_email" ADD COLUMN     "convite_assinatura_id" TEXT;

-- CreateTable
CREATE TABLE "expedicao_documento" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "operador_id" TEXT NOT NULL,
    "modalidade" "modalidade_assinatura" NOT NULL,
    "estado" "estado_expedicao" NOT NULL DEFAULT 'AGUARDANDO',
    "fuso_iana" VARCHAR(100) NOT NULL,
    "matriz_id" TEXT,
    "manifesto_aceite" JSONB,
    "aceite_sha256" CHAR(64),
    "via_id" TEXT,
    "arquivo_final_id" TEXT,
    "arquivo_livro_id" TEXT,
    "chave_arquivo_livro" TEXT NOT NULL,
    "codigo_verificacao" CHAR(32) NOT NULL,
    "manifesto_final" JSONB,
    "final_sha256" CHAR(64),
    "expedido_em" TIMESTAMP(3),
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "executar_apos" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserva_id" TEXT,
    "reserva_ate" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expedicao_documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "convite_assinatura" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "arrolado_id" TEXT NOT NULL,
    "usuario_id" TEXT,
    "auth_version" INTEGER,
    "email" VARCHAR(255) NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "consumido_em" TIMESTAMP(3),
    "revogado_em" TIMESTAMP(3),
    "recusado_em" TIMESTAMP(3),
    "motivo_recusa" VARCHAR(1000),
    "matriz_consultada_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "convite_assinatura_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assinatura_documento" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "arrolado_id" TEXT NOT NULL,
    "convite_id" TEXT,
    "metodo" "modalidade_assinatura" NOT NULL,
    "manifesto_sha256" CHAR(64) NOT NULL,
    "registrada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidencias" JSONB NOT NULL,

    CONSTRAINT "assinatura_documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conferencia_fisica" (
    "versao_id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "arquivo_id" TEXT NOT NULL,
    "operador_id" TEXT NOT NULL,
    "operador_nome" VARCHAR(255) NOT NULL,
    "evidencia" VARCHAR(1000) NOT NULL,
    "conferida_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conferencia_fisica_pkey" PRIMARY KEY ("versao_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expedicao_documento_versao_id_key" ON "expedicao_documento"("versao_id");

-- CreateIndex
CREATE UNIQUE INDEX "expedicao_documento_via_id_key" ON "expedicao_documento"("via_id");

-- CreateIndex
CREATE UNIQUE INDEX "expedicao_documento_arquivo_final_id_key" ON "expedicao_documento"("arquivo_final_id");

-- CreateIndex
CREATE UNIQUE INDEX "expedicao_documento_arquivo_livro_id_key" ON "expedicao_documento"("arquivo_livro_id");

-- CreateIndex
CREATE UNIQUE INDEX "expedicao_documento_codigo_verificacao_key" ON "expedicao_documento"("codigo_verificacao");

-- CreateIndex
CREATE INDEX "expedicao_documento_estado_executar_apos_idx" ON "expedicao_documento"("estado", "executar_apos");

-- CreateIndex
CREATE UNIQUE INDEX "expedicao_documento_versao_id_igreja_id_contexto_id_key" ON "expedicao_documento"("versao_id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "convite_assinatura_hash_key" ON "convite_assinatura"("hash");

-- CreateIndex
CREATE INDEX "convite_assinatura_versao_id_arrolado_id_idx" ON "convite_assinatura"("versao_id", "arrolado_id");

-- CreateIndex
CREATE UNIQUE INDEX "convite_escopo_key" ON "convite_assinatura"("id", "arrolado_id", "igreja_id", "contexto_id", "versao_id");

-- CreateIndex
CREATE UNIQUE INDEX "assinatura_documento_arrolado_id_key" ON "assinatura_documento"("arrolado_id");

-- CreateIndex
CREATE UNIQUE INDEX "assinatura_documento_convite_id_key" ON "assinatura_documento"("convite_id");

-- CreateIndex
CREATE INDEX "assinatura_documento_versao_id_idx" ON "assinatura_documento"("versao_id");

-- CreateIndex
CREATE UNIQUE INDEX "assinatura_escopo_key" ON "assinatura_documento"("arrolado_id", "igreja_id", "contexto_id", "versao_id");

-- CreateIndex
CREATE UNIQUE INDEX "assinatura_convite_key" ON "assinatura_documento"("convite_id", "arrolado_id", "igreja_id", "contexto_id", "versao_id");

-- CreateIndex
CREATE UNIQUE INDEX "conferencia_fisica_arquivo_id_key" ON "conferencia_fisica"("arquivo_id");

-- CreateIndex
CREATE UNIQUE INDEX "conferencia_escopo_key" ON "conferencia_fisica"("versao_id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_email_convite_assinatura_id_key" ON "outbox_email"("convite_assinatura_id");

-- AddForeignKey
ALTER TABLE "outbox_email" ADD CONSTRAINT "outbox_email_convite_assinatura_fkey" FOREIGN KEY ("convite_assinatura_id") REFERENCES "convite_assinatura"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expedicao_documento" ADD CONSTRAINT "expedicao_versao_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expedicao_documento" ADD CONSTRAINT "expedicao_operador_fkey" FOREIGN KEY ("operador_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expedicao_documento" ADD CONSTRAINT "expedicao_matriz_fkey" FOREIGN KEY ("matriz_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expedicao_documento" ADD CONSTRAINT "expedicao_via_fkey" FOREIGN KEY ("via_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expedicao_documento" ADD CONSTRAINT "expedicao_final_fkey" FOREIGN KEY ("arquivo_final_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expedicao_documento" ADD CONSTRAINT "expedicao_faces_fkey" FOREIGN KEY ("arquivo_livro_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "convite_assinatura" ADD CONSTRAINT "convite_expedicao_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "expedicao_documento"("versao_id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "convite_assinatura" ADD CONSTRAINT "convite_arrolado_fkey" FOREIGN KEY ("arrolado_id", "igreja_id", "contexto_id", "versao_id") REFERENCES "arrolado_documento"("id", "igreja_id", "contexto_id", "versao_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "convite_assinatura" ADD CONSTRAINT "convite_usuario_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assinatura_documento" ADD CONSTRAINT "assinatura_expedicao_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "expedicao_documento"("versao_id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assinatura_documento" ADD CONSTRAINT "assinatura_arrolado_fkey" FOREIGN KEY ("arrolado_id", "igreja_id", "contexto_id", "versao_id") REFERENCES "arrolado_documento"("id", "igreja_id", "contexto_id", "versao_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assinatura_documento" ADD CONSTRAINT "assinatura_convite_fkey" FOREIGN KEY ("convite_id", "arrolado_id", "igreja_id", "contexto_id", "versao_id") REFERENCES "convite_assinatura"("id", "arrolado_id", "igreja_id", "contexto_id", "versao_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conferencia_fisica" ADD CONSTRAINT "conferencia_expedicao_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "expedicao_documento"("versao_id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conferencia_fisica" ADD CONSTRAINT "conferencia_scan_fkey" FOREIGN KEY ("arquivo_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conferencia_fisica" ADD CONSTRAINT "conferencia_operador_fkey" FOREIGN KEY ("operador_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE "outbox_email" DROP CONSTRAINT "outbox_email_destino_check";
ALTER TABLE "outbox_email" ADD CONSTRAINT "outbox_email_destino_check" CHECK (
  num_nonnulls("token_id", "confirmacao_id", "convite_assinatura_id") = 1
);

ALTER TABLE "convite_assinatura"
  ADD CONSTRAINT "convite_conta_check" CHECK (("usuario_id" IS NULL) = ("auth_version" IS NULL)),
  ADD CONSTRAINT "convite_desfecho_check" CHECK (num_nonnulls("consumido_em", "revogado_em", "recusado_em") <= 1);

ALTER TABLE "assinatura_documento" ADD CONSTRAINT "assinatura_metodo_check"
  CHECK (("metodo" = 'ELETRONICA') = ("convite_id" IS NOT NULL));

ALTER TABLE "expedicao_documento"
  ADD CONSTRAINT "expedicao_aceite_check" CHECK (num_nonnulls("matriz_id", "manifesto_aceite", "aceite_sha256") IN (0, 3)),
  ADD CONSTRAINT "expedicao_final_check" CHECK (
    ("estado" = 'CONCLUIDA' AND num_nonnulls("arquivo_final_id", "manifesto_final", "final_sha256", "expedido_em") = 4)
    OR ("estado" <> 'CONCLUIDA' AND num_nonnulls("arquivo_final_id", "manifesto_final", "final_sha256", "expedido_em") = 0)
  );

CREATE OR REPLACE FUNCTION e04_validar_documento() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.numero IS NOT NULL AND
    (NEW.numero, NEW.ano, NEW.sigla, NEW.tipo, NEW.perfil, NEW.contexto_id, NEW.igreja_id) IS DISTINCT FROM
    (OLD.numero, OLD.ano, OLD.sigla, OLD.tipo, OLD.perfil, OLD.contexto_id, OLD.igreja_id) THEN
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

CREATE FUNCTION e07_validar_expedicao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Histórico de expedição imutável' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (NEW.id, NEW.versao_id, NEW.igreja_id, NEW.contexto_id, NEW.operador_id, NEW.modalidade, NEW.fuso_iana,
      NEW.codigo_verificacao, NEW.chave_arquivo_livro, NEW.criado_em) IS DISTINCT FROM
    (OLD.id, OLD.versao_id, OLD.igreja_id, OLD.contexto_id, OLD.operador_id, OLD.modalidade, OLD.fuso_iana,
      OLD.codigo_verificacao, OLD.chave_arquivo_livro, OLD.criado_em)
    OR (OLD.matriz_id IS NOT NULL AND
      (NEW.matriz_id, NEW.manifesto_aceite, NEW.aceite_sha256) IS DISTINCT FROM
      (OLD.matriz_id, OLD.manifesto_aceite, OLD.aceite_sha256))
    OR (OLD.via_id IS NOT NULL AND NEW.via_id IS DISTINCT FROM OLD.via_id)
    OR (OLD.estado = 'CANCELADA' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.estado = 'CONCLUIDA' AND (to_jsonb(NEW) - 'via_id') IS DISTINCT FROM (to_jsonb(OLD) - 'via_id'))
  ) THEN
    RAISE EXCEPTION 'Histórico de expedição imutável' USING ERRCODE = '23514';
  END IF;
  IF NEW.estado = 'CONCLUIDA' AND (TG_OP = 'INSERT' OR OLD.estado <> 'CONCLUIDA') AND (
    NEW.matriz_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM arrolado_documento a WHERE a.versao_id = NEW.versao_id AND a.assina AND a.obrigatorio
    ) OR EXISTS (
      SELECT 1 FROM arrolado_documento a
      WHERE a.versao_id = NEW.versao_id AND a.assina AND a.obrigatorio AND NOT EXISTS (
        SELECT 1 FROM assinatura_documento s WHERE s.arrolado_id = a.id AND s.versao_id = NEW.versao_id
          AND s.metodo = NEW.modalidade AND s.manifesto_sha256 = NEW.aceite_sha256
      )
    ) OR (NEW.modalidade = 'FISICA' AND NOT EXISTS (
      SELECT 1 FROM conferencia_fisica c WHERE c.versao_id = NEW.versao_id
    ))
  ) THEN
    RAISE EXCEPTION 'Expedição exige as assinaturas obrigatórias da mesma versão' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e07_validar_expedicao BEFORE INSERT OR UPDATE OR DELETE ON expedicao_documento
FOR EACH ROW EXECUTE FUNCTION e07_validar_expedicao();

CREATE FUNCTION e07_validar_assinatura() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM expedicao_documento e
    JOIN documento_versao v ON v.id = e.versao_id
    JOIN documento d ON d.id = v.documento_id
    JOIN arrolado_documento a ON a.id = NEW.arrolado_id AND a.versao_id = v.id
    WHERE e.versao_id = NEW.versao_id AND e.modalidade = NEW.metodo AND e.estado = 'AGUARDANDO'
      AND e.aceite_sha256 = NEW.manifesto_sha256 AND a.assina
      AND v.congelado_em IS NOT NULL AND v.numero = d.versao_atual AND d.estado = 'APROVADO'
  ) THEN
    RAISE EXCEPTION 'Assinatura exige uma versão aprovada em coleta' USING ERRCODE = '23514';
  END IF;
  IF NEW.metodo = 'ELETRONICA' AND NOT EXISTS (
    SELECT 1 FROM convite_assinatura c WHERE c.id = NEW.convite_id AND c.consumido_em = NEW.registrada_em
      AND c.consumido_em < c.expira_em AND c.matriz_consultada_em IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Assinatura eletrônica exige convite individual consumido' USING ERRCODE = '23514';
  END IF;
  IF NEW.metodo = 'FISICA' AND NOT EXISTS (
    SELECT 1 FROM conferencia_fisica c WHERE c.versao_id = NEW.versao_id
  ) THEN
    RAISE EXCEPTION 'Assinatura física exige digitalização conferida' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e07_validar_assinatura BEFORE INSERT ON assinatura_documento
FOR EACH ROW EXECUTE FUNCTION e07_validar_assinatura();
CREATE TRIGGER e07_assinatura_imutavel BEFORE UPDATE OR DELETE ON assinatura_documento
FOR EACH ROW EXECUTE FUNCTION e04_versao_modelo_imutavel();
CREATE TRIGGER e07_conferencia_imutavel BEFORE UPDATE OR DELETE ON conferencia_fisica
FOR EACH ROW EXECUTE FUNCTION e04_versao_modelo_imutavel();

CREATE FUNCTION e07_preservar_convite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.consumido_em IS NOT NULL OR OLD.revogado_em IS NOT NULL OR OLD.recusado_em IS NOT NULL
    OR (to_jsonb(NEW) - ARRAY['consumido_em','recusado_em','revogado_em','motivo_recusa','matriz_consultada_em'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumido_em','recusado_em','revogado_em','motivo_recusa','matriz_consultada_em'])
    OR (OLD.matriz_consultada_em IS NOT NULL AND NEW.matriz_consultada_em IS DISTINCT FROM OLD.matriz_consultada_em)
  THEN
    RAISE EXCEPTION 'Histórico do convite imutável' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e07_preservar_convite BEFORE UPDATE OR DELETE ON convite_assinatura
FOR EACH ROW EXECUTE FUNCTION e07_preservar_convite();

CREATE OR REPLACE FUNCTION proteger_arquivo_artefato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trabalho_renderizacao WHERE arquivo_id = OLD.id)
    OR EXISTS (SELECT 1 FROM livro_atas WHERE arquivo_historico_id = OLD.id)
    OR EXISTS (SELECT 1 FROM registro_livro WHERE arquivo_id = OLD.id)
    OR EXISTS (SELECT 1 FROM expedicao_documento WHERE OLD.id IN (matriz_id, via_id, arquivo_final_id, arquivo_livro_id))
    OR EXISTS (SELECT 1 FROM conferencia_fisica WHERE arquivo_id = OLD.id)
  THEN
    RAISE EXCEPTION 'Metadados do artefato arquivado são imutáveis' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
