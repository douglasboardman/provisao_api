BEGIN;
-- AlterTable
ALTER TABLE "outbox_email" ADD COLUMN     "acesso_assembleia_id" TEXT;

-- AlterTable
ALTER TABLE "deliberacao_ata" ADD COLUMN     "acesso_assembleia_id" TEXT;

-- CreateTable
CREATE TABLE "acesso_assembleia" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "contexto_id" TEXT NOT NULL,
    "reuniao_id" TEXT NOT NULL,
    "versao_id" TEXT NOT NULL,
    "mesa_id" TEXT NOT NULL,
    "solicitacao" TEXT NOT NULL,
    "conta_id" TEXT,
    "conta_versao" INTEGER,
    "concedido_por" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "sessao_hash" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "consumido_em" TIMESTAMP(3),
    "revogado_em" TIMESTAMP(3),

    CONSTRAINT "acesso_assembleia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ato_acesso_assembleia" (
    "id" TEXT NOT NULL,
    "acesso_id" TEXT NOT NULL,
    "operacao" TEXT NOT NULL,
    "revisao" INTEGER NOT NULL,
    "registrado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ato_acesso_assembleia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acesso_assembleia_solicitacao_key" ON "acesso_assembleia"("solicitacao");

-- CreateIndex
CREATE UNIQUE INDEX "acesso_assembleia_hash_key" ON "acesso_assembleia"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "acesso_assembleia_sessao_hash_key" ON "acesso_assembleia"("sessao_hash");

-- CreateIndex
CREATE INDEX "acesso_assembleia_versao_id_criado_em_idx" ON "acesso_assembleia"("versao_id", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "ato_acesso_assembleia_acesso_id_operacao_revisao_key" ON "ato_acesso_assembleia"("acesso_id", "operacao", "revisao");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_email_acesso_assembleia_id_key" ON "outbox_email"("acesso_assembleia_id");

-- AddForeignKey
ALTER TABLE "outbox_email" ADD CONSTRAINT "outbox_email_acesso_assembleia_id_fkey" FOREIGN KEY ("acesso_assembleia_id") REFERENCES "acesso_assembleia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliberacao_ata" ADD CONSTRAINT "deliberacao_ata_acesso_assembleia_id_fkey" FOREIGN KEY ("acesso_assembleia_id") REFERENCES "acesso_assembleia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acesso_assembleia" ADD CONSTRAINT "acesso_assembleia_mesa_id_reuniao_id_igreja_id_contexto_id_fkey" FOREIGN KEY ("mesa_id", "reuniao_id", "igreja_id", "contexto_id") REFERENCES "mesa_assembleia"("id", "reuniao_id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acesso_assembleia" ADD CONSTRAINT "acesso_assembleia_versao_id_reuniao_id_fkey" FOREIGN KEY ("versao_id", "reuniao_id") REFERENCES "documento_versao"("id", "reuniao_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acesso_assembleia" ADD CONSTRAINT "acesso_assembleia_concedido_por_igreja_id_fkey" FOREIGN KEY ("concedido_por", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ato_acesso_assembleia" ADD CONSTRAINT "ato_acesso_assembleia_acesso_id_fkey" FOREIGN KEY ("acesso_id") REFERENCES "acesso_assembleia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE outbox_email DROP CONSTRAINT outbox_email_destino_check;
ALTER TABLE outbox_email ADD CONSTRAINT outbox_email_destino_check CHECK (num_nonnulls(token_id, confirmacao_id, convite_assinatura_id, acesso_assembleia_id) = 1);
CREATE UNIQUE INDEX acesso_assembleia_vigente ON acesso_assembleia(versao_id) WHERE revogado_em IS NULL;
CREATE FUNCTION encerrar_acessos_da_mesa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE acesso_assembleia SET revogado_em = CURRENT_TIMESTAMP
    WHERE reuniao_id = NEW.reuniao_id AND mesa_id <> NEW.id AND revogado_em IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER acesso_mudanca_mesa AFTER INSERT ON mesa_assembleia FOR EACH ROW EXECUTE FUNCTION encerrar_acessos_da_mesa();

CREATE FUNCTION encerrar_acessos_da_ata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE acesso_assembleia a SET revogado_em = CURRENT_TIMESTAMP FROM documento_versao v
    WHERE a.versao_id = v.id AND v.documento_id = NEW.id AND a.revogado_em IS NULL
    AND (NEW.estado <> 'EM_EDICAO' OR v.numero <> NEW.versao_atual OR (OLD.encaminhado_em IS NOT NULL AND NEW.encaminhado_em IS NULL));
  RETURN NEW;
END $$;
CREATE TRIGGER acesso_formalizacao AFTER UPDATE OF estado,versao_atual,encaminhado_em ON documento FOR EACH ROW EXECUTE FUNCTION encerrar_acessos_da_ata();

CREATE FUNCTION encerrar_acessos_da_reuniao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.dados->>'situacao') NOT IN ('EM_ANDAMENTO','ENCERRADA') OR ((OLD.dados->>'situacao') = 'ENCERRADA' AND (NEW.dados->>'situacao') = 'EM_ANDAMENTO') THEN
    UPDATE acesso_assembleia SET revogado_em = CURRENT_TIMESTAMP WHERE reuniao_id = NEW.id AND revogado_em IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acesso_fim_sessao AFTER UPDATE OF dados ON reuniao FOR EACH ROW EXECUTE FUNCTION encerrar_acessos_da_reuniao();
COMMIT;
