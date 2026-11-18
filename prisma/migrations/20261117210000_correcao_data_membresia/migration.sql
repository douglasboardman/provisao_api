-- CreateTable
CREATE TABLE "correcao_data_membresia" (
    "id" TEXT NOT NULL,
    "igreja_id" TEXT NOT NULL,
    "evento_id" TEXT NOT NULL,
    "data_anterior" DATE NOT NULL,
    "data_nova" DATE NOT NULL,
    "impacto" JSONB NOT NULL,
    "justificativa" VARCHAR(1000) NOT NULL,
    "autoridade" VARCHAR(255) NOT NULL,
    "evidencia" VARCHAR(1000) NOT NULL,
    "idempotencia" UUID NOT NULL,
    "criado_por_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correcao_data_membresia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "correcao_data_membresia_igreja_id_evento_id_idx" ON "correcao_data_membresia"("igreja_id", "evento_id");

-- CreateIndex
CREATE UNIQUE INDEX "correcao_data_membresia_igreja_id_idempotencia_key" ON "correcao_data_membresia"("igreja_id", "idempotencia");

-- CreateIndex
CREATE UNIQUE INDEX "eventos_membresia_id_igreja_id_key" ON "eventos_membresia"("id", "igreja_id");

-- AddForeignKey
ALTER TABLE "correcao_data_membresia" ADD CONSTRAINT "correcao_data_membresia_evento_id_igreja_id_fkey" FOREIGN KEY ("evento_id", "igreja_id") REFERENCES "eventos_membresia"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "correcao_data_membresia" ADD CONSTRAINT "correcao_data_membresia_criado_por_id_igreja_id_fkey" FOREIGN KEY ("criado_por_id", "igreja_id") REFERENCES "usuarios"("id", "igreja_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "correcao_data_membresia" ADD CONSTRAINT "correcao_data_valida" CHECK (
 "data_anterior" <> "data_nova" AND length(btrim("justificativa")) > 0 AND length(btrim("autoridade")) > 0 AND length(btrim("evidencia")) > 0
);

-- Exceção transacional limitada a um evento e à data da correção auditada.
CREATE OR REPLACE FUNCTION proteger_membresia_de_mandato() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE igreja text; pessoa text; data_relevante date;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.igreja_id, OLD.pessoa_id) IS DISTINCT FROM (NEW.igreja_id, NEW.pessoa_id) THEN
    RAISE EXCEPTION 'Troca de igreja ou pessoa em evento de membresia não é permitida' USING ERRCODE = '23514';
  END IF;
  igreja := CASE WHEN TG_OP = 'DELETE' THEN OLD.igreja_id ELSE NEW.igreja_id END;
  pessoa := CASE WHEN TG_OP = 'DELETE' THEN OLD.pessoa_id ELSE NEW.pessoa_id END;
  PERFORM id FROM pessoas WHERE id = pessoa AND igreja_id = igreja FOR UPDATE;
  IF TG_OP = 'UPDATE' AND (OLD.tipo_evento, OLD.rol, OLD.motivacao_evento, OLD.data_evento) IS NOT DISTINCT FROM (NEW.tipo_evento, NEW.rol, NEW.motivacao_evento, NEW.data_evento) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND current_setting('provisao.correcao_evento', true) = OLD.id
     AND current_setting('provisao.correcao_data', true) = NEW.data_evento::text
     AND (OLD.tipo_evento, OLD.rol, OLD.motivacao_evento, OLD.rol_origem) IS NOT DISTINCT FROM (NEW.tipo_evento, NEW.rol, NEW.motivacao_evento, NEW.rol_origem)
     AND EXISTS (SELECT 1 FROM correcao_data_membresia c WHERE c.id = current_setting('provisao.correcao_id', true)
       AND c.igreja_id = OLD.igreja_id AND c.evento_id = OLD.id AND c.data_anterior = OLD.data_evento AND c.data_nova = NEW.data_evento)
  THEN RETURN NEW; END IF;
  data_relevante := CASE WHEN TG_OP = 'INSERT' THEN NEW.data_evento WHEN TG_OP = 'DELETE' THEN OLD.data_evento ELSE LEAST(OLD.data_evento, NEW.data_evento) END;
  IF EXISTS (SELECT 1 FROM mandato_oficial m JOIN oficial o ON o.id = m.oficial_id AND o.igreja_id = m.igreja_id WHERE o.igreja_id = igreja AND o.pessoa_id = pessoa AND data_relevante <= m.data_posse) THEN
    RAISE EXCEPTION 'Alteração de membresia exige conferência de impacto em mandato' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
