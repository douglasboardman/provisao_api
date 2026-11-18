-- CreateEnum
CREATE TYPE "contexto_secretaria_tipo" AS ENUM ('ORGAO', 'ASSEMBLEIA_GERAL');

-- CreateEnum
CREATE TYPE "documento_tipo" AS ENUM ('ATA', 'OUTRO');

-- CreateEnum
CREATE TYPE "documento_estado" AS ENUM ('EM_EDICAO', 'APROVADO', 'EXPEDIDO', 'CANCELADO', 'ANULADO');

-- CreateTable
CREATE TABLE "contexto_secretaria" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "tipo" "contexto_secretaria_tipo" NOT NULL,
    "orgao_id" TEXT,
    "nome" VARCHAR(255) NOT NULL,
    "sigla" VARCHAR(40) NOT NULL,

    CONSTRAINT "contexto_secretaria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competencia_secretaria" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "registrado_por_id" TEXT NOT NULL,
    "inicio" DATE NOT NULL,
    "fim" DATE,
    "pode_aprovar" BOOLEAN NOT NULL,
    "pode_deliberar" BOOLEAN NOT NULL,
    "pode_consultar_restritos" BOOLEAN NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" VARCHAR(1000) NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competencia_secretaria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modelo_documento" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "nome" VARCHAR(255) NOT NULL,
    "revisao" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "modelo_documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modelo_documento_versao" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "modelo_id" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "tipo" "documento_tipo" NOT NULL,
    "finalidade" VARCHAR(100) NOT NULL,
    "configuracao" JSONB NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modelo_documento_versao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reuniao" (
    "restrito" BOOLEAN NOT NULL DEFAULT false,
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "revisao" INTEGER NOT NULL DEFAULT 1,
    "modalidade" VARCHAR(40) NOT NULL,
    "data" DATE NOT NULL,
    "dados" JSONB NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reuniao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participante_reuniao" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "reuniao_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "presente" BOOLEAN NOT NULL,
    "papeis" TEXT[],
    "retrato" JSONB NOT NULL,

    CONSTRAINT "participante_reuniao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documento" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "estado" "documento_estado" NOT NULL DEFAULT 'EM_EDICAO',
    "revisao" INTEGER NOT NULL DEFAULT 1,
    "versao_atual" INTEGER NOT NULL DEFAULT 1,
    "restrito" BOOLEAN NOT NULL DEFAULT false,
    "tipo" "documento_tipo" NOT NULL,
    "perfil" VARCHAR(80) NOT NULL,
    "numero" INTEGER,
    "ano" INTEGER,
    "sigla" VARCHAR(40),
    "encaminhado_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documento_versao" (
    "revisao_conteudo" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "documento_id" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "modelo_versao_id" TEXT NOT NULL,
    "reuniao_id" TEXT,
    "motivador_id" TEXT,
    "retifica_versao_id" TEXT,
    "assunto" VARCHAR(255) NOT NULL,
    "data_documento" DATE NOT NULL,
    "conteudo" JSONB NOT NULL,
    "congelado_em" TIMESTAMP(3),
    "fonte_congelada" JSONB,

    CONSTRAINT "documento_versao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arrolado_documento" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "orgao_id" TEXT,
    "cargo_id" TEXT,
    "papeis" TEXT[],
    "assina" BOOLEAN NOT NULL DEFAULT false,
    "obrigatorio" BOOLEAN NOT NULL DEFAULT false,
    "responsavel" BOOLEAN NOT NULL DEFAULT false,
    "retrato" JSONB NOT NULL,

    CONSTRAINT "arrolado_documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anexo_documento" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "arquivo_id" TEXT NOT NULL,
    "nome" VARCHAR(255) NOT NULL,

    CONSTRAINT "anexo_documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliberacao_ata" (
    "revisao_conteudo" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "reuniao_id" TEXT NOT NULL,
    "resultado" VARCHAR(40) NOT NULL,
    "data" DATE NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" VARCHAR(1000) NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deliberacao_ata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contador_documento" (
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "tipo" "documento_tipo" NOT NULL,
    "perfil" VARCHAR(80) NOT NULL,
    "ano" INTEGER NOT NULL,
    "ultimo" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "contador_documento_pkey" PRIMARY KEY ("igreja_id","contexto_id","tipo","perfil","ano")
);

-- CreateTable
CREATE TABLE "comando_secretaria" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "chave" UUID NOT NULL,
    "operacao" VARCHAR(80) NOT NULL,
    "alvo_id" TEXT,
    "hash" CHAR(64) NOT NULL,
    "dados" JSONB NOT NULL,
    "resultado" JSONB NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comando_secretaria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contexto_secretaria_orgao_id_key" ON "contexto_secretaria"("orgao_id");

-- CreateIndex
CREATE INDEX "contexto_secretaria_igreja_id_idx" ON "contexto_secretaria"("igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "contexto_secretaria_id_igreja_id_key" ON "contexto_secretaria"("id", "igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "contexto_secretaria_orgao_id_igreja_id_key" ON "contexto_secretaria"("orgao_id", "igreja_id");

-- CreateIndex
CREATE INDEX "competencia_secretaria_igreja_id_contexto_id_usuario_id_idx" ON "competencia_secretaria"("igreja_id", "contexto_id", "usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "modelo_documento_id_igreja_id_contexto_id_key" ON "modelo_documento"("id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "modelo_documento_versao_id_igreja_id_contexto_id_key" ON "modelo_documento_versao"("id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "modelo_documento_versao_modelo_id_numero_key" ON "modelo_documento_versao"("modelo_id", "numero");

-- CreateIndex
CREATE INDEX "reuniao_igreja_id_contexto_id_data_idx" ON "reuniao"("igreja_id", "contexto_id", "data");

-- CreateIndex
CREATE UNIQUE INDEX "reuniao_id_igreja_id_contexto_id_key" ON "reuniao"("id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "participante_reuniao_reuniao_id_pessoa_id_key" ON "participante_reuniao"("reuniao_id", "pessoa_id");

-- CreateIndex
CREATE INDEX "documento_igreja_id_contexto_id_criado_em_idx" ON "documento"("igreja_id", "contexto_id", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "documento_id_igreja_id_contexto_id_key" ON "documento"("id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "documento_igreja_id_contexto_id_tipo_perfil_ano_numero_key" ON "documento"("igreja_id", "contexto_id", "tipo", "perfil", "ano", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "documento_versao_id_igreja_id_key" ON "documento_versao"("id", "igreja_id");

-- CreateIndex
CREATE UNIQUE INDEX "documento_versao_id_igreja_id_contexto_id_key" ON "documento_versao"("id", "igreja_id", "contexto_id");

-- CreateIndex
CREATE UNIQUE INDEX "documento_versao_documento_id_numero_key" ON "documento_versao"("documento_id", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "arrolado_documento_versao_id_pessoa_id_key" ON "arrolado_documento"("versao_id", "pessoa_id");

-- CreateIndex
CREATE UNIQUE INDEX "anexo_documento_versao_id_arquivo_id_key" ON "anexo_documento"("versao_id", "arquivo_id");

-- CreateIndex
CREATE INDEX "deliberacao_ata_igreja_id_versao_id_idx" ON "deliberacao_ata"("igreja_id", "versao_id");

-- CreateIndex
CREATE INDEX "comando_secretaria_igreja_id_alvo_id_criado_em_idx" ON "comando_secretaria"("igreja_id", "alvo_id", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "comando_secretaria_igreja_id_chave_key" ON "comando_secretaria"("igreja_id", "chave");

-- CreateIndex
CREATE UNIQUE INDEX "arquivo_privado_id_igreja_id_key" ON "arquivo_privado"("id", "igreja_id");

-- AddForeignKey
ALTER TABLE "contexto_secretaria" ADD CONSTRAINT "contexto_secretaria_igreja_id_fkey" FOREIGN KEY ("igreja_id") REFERENCES "igreja"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contexto_secretaria" ADD CONSTRAINT "contexto_secretaria_orgao_id_igreja_id_fkey" FOREIGN KEY ("orgao_id", "igreja_id") REFERENCES "orgao_interno"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "competencia_secretaria" ADD CONSTRAINT "competencia_secretaria_contexto_id_igreja_id_fkey" FOREIGN KEY ("contexto_id", "igreja_id") REFERENCES "contexto_secretaria"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "competencia_secretaria" ADD CONSTRAINT "competencia_secretaria_usuario_id_igreja_id_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "competencia_secretaria" ADD CONSTRAINT "competencia_secretaria_registrado_por_id_igreja_id_fkey" FOREIGN KEY ("registrado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "modelo_documento" ADD CONSTRAINT "modelo_documento_contexto_id_igreja_id_fkey" FOREIGN KEY ("contexto_id", "igreja_id") REFERENCES "contexto_secretaria"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "modelo_documento_versao" ADD CONSTRAINT "modelo_documento_versao_modelo_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("modelo_id", "igreja_id", "contexto_id") REFERENCES "modelo_documento"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reuniao" ADD CONSTRAINT "reuniao_contexto_id_igreja_id_fkey" FOREIGN KEY ("contexto_id", "igreja_id") REFERENCES "contexto_secretaria"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "participante_reuniao" ADD CONSTRAINT "participante_reuniao_reuniao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("reuniao_id", "igreja_id", "contexto_id") REFERENCES "reuniao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "participante_reuniao" ADD CONSTRAINT "participante_reuniao_pessoa_id_igreja_id_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documento" ADD CONSTRAINT "documento_contexto_id_igreja_id_fkey" FOREIGN KEY ("contexto_id", "igreja_id") REFERENCES "contexto_secretaria"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documento_versao" ADD CONSTRAINT "documento_versao_documento_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("documento_id", "igreja_id", "contexto_id") REFERENCES "documento"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documento_versao" ADD CONSTRAINT "documento_versao_modelo_versao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("modelo_versao_id", "igreja_id", "contexto_id") REFERENCES "modelo_documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documento_versao" ADD CONSTRAINT "documento_versao_reuniao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("reuniao_id", "igreja_id", "contexto_id") REFERENCES "reuniao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documento_versao" ADD CONSTRAINT "documento_versao_motivador_id_igreja_id_fkey" FOREIGN KEY ("motivador_id", "igreja_id") REFERENCES "documento_versao"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documento_versao" ADD CONSTRAINT "documento_versao_retifica_versao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("retifica_versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "arrolado_documento" ADD CONSTRAINT "arrolado_documento_versao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "arrolado_documento" ADD CONSTRAINT "arrolado_documento_pessoa_id_igreja_id_fkey" FOREIGN KEY ("pessoa_id", "igreja_id") REFERENCES "pessoas"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "arrolado_documento" ADD CONSTRAINT "arrolado_documento_cargo_id_igreja_id_orgao_id_fkey" FOREIGN KEY ("cargo_id", "igreja_id", "orgao_id") REFERENCES "cargo_orgao"("id", "igreja_id", "orgao_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "anexo_documento" ADD CONSTRAINT "anexo_documento_versao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "anexo_documento" ADD CONSTRAINT "anexo_documento_arquivo_id_igreja_id_fkey" FOREIGN KEY ("arquivo_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "deliberacao_ata" ADD CONSTRAINT "deliberacao_ata_versao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "deliberacao_ata" ADD CONSTRAINT "deliberacao_ata_reuniao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("reuniao_id", "igreja_id", "contexto_id") REFERENCES "reuniao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contador_documento" ADD CONSTRAINT "contador_documento_contexto_id_igreja_id_fkey" FOREIGN KEY ("contexto_id", "igreja_id") REFERENCES "contexto_secretaria"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "comando_secretaria" ADD CONSTRAINT "comando_secretaria_usuario_id_igreja_id_fkey" FOREIGN KEY ("usuario_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Invariantes que também se aplicam a gravações fora dos controllers.
ALTER TABLE contexto_secretaria ADD CONSTRAINT contexto_secretaria_tipo_check
  CHECK ((tipo = 'ORGAO') = (orgao_id IS NOT NULL));
CREATE UNIQUE INDEX contexto_secretaria_assembleia_unica ON contexto_secretaria(igreja_id) WHERE tipo = 'ASSEMBLEIA_GERAL';
ALTER TABLE competencia_secretaria ADD CONSTRAINT competencia_secretaria_periodo_check CHECK (fim IS NULL OR fim >= inicio);
ALTER TABLE documento ADD CONSTRAINT documento_numero_check CHECK ((numero IS NULL AND ano IS NULL AND sigla IS NULL) OR (numero > 0 AND ano BETWEEN 1 AND 9999 AND sigla IS NOT NULL));
ALTER TABLE arrolado_documento ADD CONSTRAINT arrolado_assinatura_check CHECK (NOT obrigatorio OR assina);
ALTER TABLE arrolado_documento ADD CONSTRAINT arrolado_cargo_check CHECK ((cargo_id IS NULL) = (orgao_id IS NULL));
ALTER TABLE contador_documento ADD CONSTRAINT contador_documento_positivo CHECK (ultimo >= 0);

CREATE FUNCTION e04_preservar_versao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.congelado_em IS NOT NULL THEN
    RAISE EXCEPTION 'Versão documental congelada é imutável' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e04_preservar_versao BEFORE UPDATE OR DELETE ON documento_versao FOR EACH ROW EXECUTE FUNCTION e04_preservar_versao();

CREATE FUNCTION e04_preservar_dependentes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    vid := OLD.versao_id;
    IF EXISTS (SELECT 1 FROM documento_versao WHERE id = vid AND congelado_em IS NOT NULL) THEN
      RAISE EXCEPTION 'Evidência de versão congelada é imutável' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM documento_versao WHERE id = NEW.versao_id AND congelado_em IS NOT NULL) THEN
      RAISE EXCEPTION 'Evidência de versão congelada é imutável' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER e04_preservar_arrolado BEFORE INSERT OR UPDATE OR DELETE ON arrolado_documento FOR EACH ROW EXECUTE FUNCTION e04_preservar_dependentes();
CREATE TRIGGER e04_preservar_anexo BEFORE INSERT OR UPDATE OR DELETE ON anexo_documento FOR EACH ROW EXECUTE FUNCTION e04_preservar_dependentes();

CREATE FUNCTION e04_versao_modelo_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registro histórico imutável' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER e04_modelo_imutavel BEFORE UPDATE OR DELETE ON modelo_documento_versao FOR EACH ROW EXECUTE FUNCTION e04_versao_modelo_imutavel();
CREATE TRIGGER e04_deliberacao_imutavel BEFORE UPDATE OR DELETE ON deliberacao_ata FOR EACH ROW EXECUTE FUNCTION e04_versao_modelo_imutavel();
CREATE TRIGGER e04_comando_imutavel BEFORE UPDATE OR DELETE ON comando_secretaria FOR EACH ROW EXECUTE FUNCTION e04_versao_modelo_imutavel();

CREATE FUNCTION e04_validar_documento() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.numero IS NOT NULL AND (NEW.numero, NEW.ano, NEW.sigla, NEW.tipo, NEW.perfil, NEW.contexto_id, NEW.igreja_id) IS DISTINCT FROM (OLD.numero, OLD.ano, OLD.sigla, OLD.tipo, OLD.perfil, OLD.contexto_id, OLD.igreja_id) THEN
    RAISE EXCEPTION 'Número reservado e série histórica são imutáveis' USING ERRCODE = '23514';
  END IF;
  IF NEW.estado = 'EXPEDIDO' AND OLD.estado <> 'EXPEDIDO' THEN
    RAISE EXCEPTION 'Expedição indisponível até E07' USING ERRCODE = '23514';
  END IF;
  IF OLD.estado IN ('EXPEDIDO', 'ANULADO', 'CANCELADO') AND (to_jsonb(NEW) - 'estado' - 'revisao') IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'revisao') THEN
    RAISE EXCEPTION 'Documento finalizado não admite edição' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e04_validar_documento BEFORE UPDATE ON documento FOR EACH ROW EXECUTE FUNCTION e04_validar_documento();

CREATE FUNCTION e04_validar_motivador() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.motivador_id = NEW.id OR EXISTS (
    WITH RECURSIVE cadeia AS (
      SELECT id, documento_id, motivador_id FROM documento_versao WHERE id = NEW.motivador_id
      UNION
      SELECT v.id, v.documento_id, v.motivador_id FROM documento_versao v JOIN cadeia c ON v.id = c.motivador_id
    ) SELECT 1 FROM cadeia WHERE documento_id = NEW.documento_id
  ) THEN
    RAISE EXCEPTION 'Motivador circular ou autorreferente' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e04_validar_motivador BEFORE INSERT OR UPDATE OF motivador_id ON documento_versao FOR EACH ROW EXECUTE FUNCTION e04_validar_motivador();
