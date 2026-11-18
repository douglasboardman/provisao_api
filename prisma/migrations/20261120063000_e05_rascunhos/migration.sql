-- Trabalhos e artefatos de rascunho; não representa assinatura nem expedição.
CREATE TABLE "trabalho_renderizacao" (
  "id" TEXT NOT NULL,
  "igreja_id" TEXT NOT NULL,
  "contexto_id" TEXT NOT NULL,
  "versao_id" TEXT NOT NULL,
  "revisao_documento" INTEGER NOT NULL,
  "usuario_id" TEXT NOT NULL,
  "fonte" JSONB NOT NULL,
  "estado" VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  "tentativas" INTEGER NOT NULL DEFAULT 0,
  "reserva_id" TEXT,
  "reserva_ate" TIMESTAMP(3),
  "arquivo_id" TEXT,
  "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "concluido_em" TIMESTAMP(3),
  CONSTRAINT "trabalho_renderizacao_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trabalho_renderizacao_estado_check" CHECK ("estado" IN ('PENDENTE','PROCESSANDO','CONCLUIDO','FALHOU','OBSOLETO')),
  CONSTRAINT "trabalho_renderizacao_versao_fkey" FOREIGN KEY ("versao_id", "igreja_id", "contexto_id") REFERENCES "documento_versao"("id", "igreja_id", "contexto_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "trabalho_renderizacao_arquivo_fkey" FOREIGN KEY ("arquivo_id", "igreja_id") REFERENCES "arquivo_privado"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "trabalho_renderizacao_versao_id_revisao_documento_key" ON "trabalho_renderizacao"("versao_id", "revisao_documento");
CREATE INDEX "trabalho_renderizacao_estado_criado_em_idx" ON "trabalho_renderizacao"("estado", "criado_em");
