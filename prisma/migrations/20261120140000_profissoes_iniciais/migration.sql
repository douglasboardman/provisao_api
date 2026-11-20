BEGIN;

CREATE FUNCTION cadastrar_profissoes_iniciais(id_igreja TEXT) RETURNS VOID
LANGUAGE SQL AS $$
  INSERT INTO "profissoes" ("id", "igreja_id", "nome")
  SELECT gen_random_uuid()::text, id_igreja, nome
  FROM (VALUES
    ('Advogado(a)'),
    ('Analista de sistemas'),
    ('Arquiteto(a)'),
    ('Assistente administrativo(a)'),
    ('Assistente social'),
    ('Bancário(a)'),
    ('Cabeleireiro(a)'),
    ('Comerciante'),
    ('Contador(a)'),
    ('Corretor(a) de imóveis'),
    ('Costureiro(a)'),
    ('Cozinheiro(a)'),
    ('Dentista'),
    ('Do lar'),
    ('Eletricista'),
    ('Empresário(a)'),
    ('Enfermeiro(a)'),
    ('Engenheiro(a)'),
    ('Farmacêutico(a)'),
    ('Fisioterapeuta'),
    ('Mecânico(a)'),
    ('Médico(a)'),
    ('Militar'),
    ('Motorista'),
    ('Nutricionista'),
    ('Pedagogo(a)'),
    ('Pedreiro(a)'),
    ('Policial civil'),
    ('Policial militar'),
    ('Policial penal'),
    ('Produtor(a) rural'),
    ('Professor(a)'),
    ('Psicólogo(a)'),
    ('Recepcionista'),
    ('Servidor(a) público(a)'),
    ('Técnico(a) de enfermagem'),
    ('Trabalhador(a) rural'),
    ('Vendedor(a)'),
    ('Vigilante')
  ) AS catalogo(nome)
  ON CONFLICT DO NOTHING;
$$;

CREATE FUNCTION iniciar_profissoes_da_igreja() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cadastrar_profissoes_iniciais(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER igreja_profissoes_iniciais
AFTER INSERT ON "igreja"
FOR EACH ROW EXECUTE FUNCTION iniciar_profissoes_da_igreja();

SELECT cadastrar_profissoes_iniciais("id") FROM "igreja";

COMMIT;
