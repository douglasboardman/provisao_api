CREATE TABLE "campo_secretaria" (
  "id" TEXT PRIMARY KEY, "igreja_id" TEXT NOT NULL REFERENCES "igreja"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "nome" VARCHAR(120) NOT NULL, "codigo" TEXT, "tipo" TEXT NOT NULL, "multiplo" BOOLEAN NOT NULL,
  "origem" TEXT NOT NULL, "ativo" BOOLEAN NOT NULL DEFAULT true, "revisao" INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX "campo_secretaria_igreja_id_codigo_key" ON "campo_secretaria"("igreja_id","codigo");
CREATE INDEX "campo_secretaria_igreja_id_ativo_idx" ON "campo_secretaria"("igreja_id","ativo");

CREATE FUNCTION instalar_campos_secretaria(igreja_destino TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria(id, igreja_id, codigo, nome, tipo, multiplo, origem)
  SELECT gen_random_uuid()::text, igreja_destino, codigo, nome, tipo, multiplo, origem FROM (VALUES
    ('IGREJA','Nome da igreja','texto',false,'igreja'),
    ('ASSUNTO','Assunto do documento','texto',false,'assunto'),
    ('DATA_DOCUMENTO','Data do documento','data',false,'data_documento'),
    ('LOCAL_REUNIAO','Local da reunião realizada','texto',false,'local_reuniao'),
    ('PRESENTES','Presentes na reunião','texto',true,'presentes'),
    ('DATA_REUNIAO','Data convocada','data',false,'manual'),
    ('PAUTA','Itens de pauta','texto',true,'manual'),
    ('LOCAL','Local previsto','texto',false,'manual'),
    ('HORARIO','Horário','texto',false,'manual'),
    ('REGISTRO','Registro da reunião','texto',false,'manual'),
    ('DESTINATARIOS','Destinatários','texto',true,'manual'),
    ('DESTINATARIO','Destinatário','texto',false,'manual'),
    ('MENSAGEM','Mensagem','texto',false,'manual'),
    ('PERIODO','Período','texto',false,'manual'),
    ('ATIVIDADES','Atividades','texto',true,'manual'),
    ('RESULTADOS','Resultados','texto',true,'manual'),
    ('AUTORIDADE','Autoridade','texto',false,'manual'),
    ('OBSERVACOES','Observações','texto',false,'manual')
  ) AS catalogo(codigo,nome,tipo,multiplo,origem) ON CONFLICT DO NOTHING
$$;
SELECT instalar_campos_secretaria(id) FROM igreja;
CREATE FUNCTION instalar_campos_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_secretaria(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER campos_secretaria_nova_igreja AFTER INSERT ON igreja FOR EACH ROW EXECUTE FUNCTION instalar_campos_nova_igreja();
