BEGIN;
CREATE TABLE item_pauta_reuniao (
  reuniao_id TEXT NOT NULL,
  igreja_id TEXT NOT NULL,
  contexto_id TEXT NOT NULL,
  ordem INTEGER NOT NULL CHECK (ordem > 0),
  descricao TEXT NOT NULL CHECK (length(trim(descricao)) > 0),
  proponente_id TEXT,
  PRIMARY KEY (reuniao_id, ordem),
  FOREIGN KEY (reuniao_id, igreja_id, contexto_id) REFERENCES reuniao(id, igreja_id, contexto_id) ON DELETE CASCADE ON UPDATE RESTRICT,
  FOREIGN KEY (proponente_id, igreja_id) REFERENCES pessoas(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- A pauta anterior pode conter parágrafos de um mesmo assunto.
INSERT INTO item_pauta_reuniao (reuniao_id, igreja_id, contexto_id, ordem, descricao)
SELECT id, igreja_id, contexto_id, 1, dados->>'pauta'
FROM reuniao WHERE length(trim(dados->>'pauta')) > 0;

CREATE OR REPLACE FUNCTION instalar_campos_secretaria(igreja_destino TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria(id, igreja_id, codigo, nome, tipo, multiplo, origem)
  SELECT gen_random_uuid()::text, igreja_destino, codigo, nome, tipo, multiplo, origem FROM (VALUES
    ('IGREJA','Nome da igreja','texto',false,'igreja'),
    ('ASSUNTO','Assunto do documento','texto',false,'assunto'),
    ('DATA_DOCUMENTO','Data do documento','data',false,'data_documento'),
    ('LOCAL_REUNIAO','Local da reunião realizada','texto',false,'local_reuniao'),
    ('PRESENTES','Presentes na reunião','texto',true,'presentes'),
    ('DATA_REUNIAO','Data convocada','data',false,'manual'),
    ('PAUTA_REUNIAO','Pauta da reunião vinculada','texto',true,'pauta_reuniao'),
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
INSERT INTO campo_secretaria(id, igreja_id, codigo, nome, tipo, multiplo, origem)
SELECT gen_random_uuid()::text, id, 'PAUTA_REUNIAO', 'Pauta da reunião vinculada', 'texto', true, 'pauta_reuniao'
FROM igreja ON CONFLICT (igreja_id, codigo) DO NOTHING;
COMMIT;
