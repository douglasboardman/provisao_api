BEGIN;
CREATE TABLE origem_campo_secretaria (
  chave TEXT PRIMARY KEY, cadastro TEXT NOT NULL, propriedade TEXT NOT NULL, transformacao TEXT
);
INSERT INTO origem_campo_secretaria VALUES
  ('manual', 'manual', 'valor', NULL),
  ('igreja', 'igreja', 'nome', NULL),
  ('assunto', 'documento', 'assunto', NULL),
  ('data_documento', 'documento', 'data_documento', NULL),
  ('numero_documento', 'documento', 'numero', NULL),
  ('numero_documento_por_extenso', 'documento', 'numero', 'por_extenso'),
  ('local_reuniao', 'reuniao', 'local', NULL),
  ('pauta_reuniao', 'reuniao', 'itens_pauta', 'descricoes_em_ordem'),
  ('presentes', 'reuniao', 'participantes', 'nomes_presentes'),
  ('endereco_logradouro', 'reuniao', 'local.endereco_logradouro', NULL),
  ('endereco_numero', 'reuniao', 'local.endereco_numero', NULL),
  ('endereco_complemento', 'reuniao', 'local.endereco_complemento', NULL),
  ('endereco_bairro', 'reuniao', 'local.endereco_bairro', NULL),
  ('endereco_cep', 'reuniao', 'local.endereco_cep', NULL),
  ('endereco_cidade', 'reuniao', 'local.endereco_cidade', NULL),
  ('endereco_uf', 'reuniao', 'local.endereco_uf', NULL),
  ('endereco_extenso', 'reuniao', 'local.endereco_extenso', NULL),
  ('endereco_declarativo', 'reuniao', 'local.endereco_declarativo', NULL),
  ('dia_reuniao_por_extenso', 'reuniao', 'data', 'dia_por_extenso'),
  ('mes_reuniao_por_extenso', 'reuniao', 'data', 'mes_por_extenso'),
  ('ano_reuniao_por_extenso', 'reuniao', 'data', 'ano_por_extenso'),
  ('horario_inicio_reuniao', 'reuniao', 'inicio', 'hora_local'),
  ('horario_inicio_reuniao_por_extenso', 'reuniao', 'inicio', 'hora_local_extenso'),
  ('horario_encerramento_reuniao', 'reuniao', 'fim', 'hora_local'),
  ('horario_encerramento_reuniao_por_extenso', 'reuniao', 'fim', 'hora_local_extenso'),
  ('redator_ata', 'pessoa', 'redator_ata.nome', NULL),
  ('data_prevista_reuniao', 'reuniao', 'data', NULL),
  ('horario_previsto_reuniao', 'reuniao', 'horario_previsto', NULL),
  ('horario_previsto_reuniao_por_extenso', 'reuniao', 'horario_previsto', 'hora_por_extenso'),
  ('numero_livro', 'livro', 'numero', NULL),
  ('titular_livro', 'livro', 'titular', NULL),
  ('serie_livro', 'livro', 'serie', NULL),
  ('capacidade_folhas_livro', 'livro', 'capacidade_folhas', NULL),
  ('modalidade_livro', 'livro', 'modalidade', NULL),
  ('nome_convocante', 'pessoa', 'convocante.nome', NULL),
  ('nome_preparador', 'pessoa', 'preparador.nome', NULL),
  ('nome_presidente_mesa', 'mesa', 'presidente_mesa.nome', NULL),
  ('nome_secretario_mesa', 'mesa', 'secretario_mesa.nome', NULL);
ALTER TABLE campo_secretaria ADD CONSTRAINT campo_secretaria_origem_fkey
  FOREIGN KEY (origem) REFERENCES origem_campo_secretaria(chave);
CREATE FUNCTION instalar_campos_convocacao(destino TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campo_secretaria(id, igreja_id, codigo, nome, tipo, multiplo, origem)
  SELECT gen_random_uuid()::text, destino, upper(chave), nome, tipo, false, chave FROM (VALUES
    ('data_prevista_reuniao', 'Data prevista da reunião', 'data'),
    ('horario_previsto_reuniao', 'Horário previsto da reunião', 'texto'),
    ('horario_previsto_reuniao_por_extenso', 'Horário previsto da reunião por extenso', 'texto'),
    ('numero_livro', 'Número do livro', 'numero'),
    ('titular_livro', 'Titular do livro', 'texto'),
    ('serie_livro', 'Série do livro', 'texto'),
    ('capacidade_folhas_livro', 'Capacidade em folhas do livro', 'numero'),
    ('modalidade_livro', 'Modalidade do livro', 'texto'),
    ('nome_convocante', 'Nome do convocante', 'texto'),
    ('nome_preparador', 'Nome de quem preparou a minuta', 'texto'),
    ('nome_presidente_mesa', 'Presidente efetivo da mesa', 'texto'),
    ('nome_secretario_mesa', 'Secretário eleito da mesa', 'texto')
  ) AS c(chave,nome,tipo) ON CONFLICT (igreja_id,codigo) DO NOTHING
$$;
SELECT instalar_campos_convocacao(id) FROM igreja;
CREATE FUNCTION instalar_origens_nova_igreja() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_campos_convocacao(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER origens_secretaria_nova_igreja AFTER INSERT ON igreja FOR EACH ROW EXECUTE FUNCTION instalar_origens_nova_igreja();
COMMIT;
