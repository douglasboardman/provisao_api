BEGIN;

ALTER TABLE orgao_interno
  ADD COLUMN categoria text GENERATED ALWAYS AS (CASE tipo
    WHEN 'UNIDADE_MINISTERIAL' THEN 'MINISTERIO'
    WHEN 'SOCIEDADE_INTERNA' THEN 'SOCIEDADE' ELSE 'ORGAO_OFICIAL' END) STORED NOT NULL,
  ADD COLUMN tipo_padrao text,
  ADD COLUMN origem text NOT NULL DEFAULT 'CADASTRO',
  ALTER COLUMN criador_id DROP NOT NULL,
  ALTER COLUMN data_criacao DROP NOT NULL,
  DROP CONSTRAINT orgao_constituicao_compativel,
  DROP CONSTRAINT orgao_dados_obrigatorios,
  ADD CONSTRAINT orgao_interno_igreja_id_tipo_padrao_key UNIQUE (igreja_id,tipo_padrao),
  ADD CHECK ((origem = 'CADASTRO' AND criador_id IS NOT NULL AND data_criacao IS NOT NULL)
          OR (origem = 'CATALOGO' AND criador_id IS NULL AND tipo_padrao IS NOT NULL)),
  ADD CHECK (tipo_padrao IS NULL OR
    (tipo IN ('ASSEMBLEIA_GERAL','CONSELHO','JUNTA') AND tipo_padrao = tipo::text) OR
    (tipo = 'SOCIEDADE_INTERNA' AND tipo_padrao IN ('UCP','UPA','UMP','SAF','UPH'))),
  ADD CHECK ((tipo IN ('CONSELHO','JUNTA','ASSEMBLEIA_GERAL') AND constituicao = 'OFICIAL') OR
    (tipo = 'SOCIEDADE_INTERNA' AND constituicao = 'ELEICAO' AND tipo_padrao IS NOT NULL) OR
    (tipo = 'UNIDADE_MINISTERIAL' AND constituicao IN ('ELEICAO','DESIGNACAO'))),
  ADD CHECK (length(btrim(nome)) > 0 AND length(btrim(finalidade)) > 0
    AND (evidencia_instituicao IS NULL OR length(btrim(evidencia_instituicao)) > 0)
    AND (tipo <> 'UNIDADE_MINISTERIAL' OR (instituidor_id IS NOT NULL AND evidencia_instituicao IS NOT NULL)));

CREATE TABLE versao_orgao (
  id text PRIMARY KEY, igreja_id text NOT NULL, orgao_id text NOT NULL,
  numero integer NOT NULL CHECK (numero > 0),
  inicio date NOT NULL, fim date CHECK (fim > inicio),
  fonte text NOT NULL, configuracao jsonb NOT NULL,
  UNIQUE (orgao_id, numero), UNIQUE (id, igreja_id, orgao_id),
  FOREIGN KEY (orgao_id, igreja_id) REFERENCES orgao_interno(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  EXCLUDE USING gist (orgao_id WITH =, daterange(inicio,fim,'[)') WITH &&)
);

ALTER TABLE contexto_secretaria DROP CONSTRAINT contexto_secretaria_tipo_check;

-- Conserva os escritores legados que enviam somente o tipo de contexto da Assembleia.
CREATE FUNCTION vincular_contexto_institucional() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origem orgao_interno%ROWTYPE;
BEGIN
  IF NEW.tipo = 'ASSEMBLEIA_GERAL' AND NEW.orgao_id IS NULL THEN
    INSERT INTO orgao_interno(id,igreja_id,tipo,tipo_padrao,origem,constituicao,nome,sigla,finalidade)
    VALUES (gen_random_uuid()::text,NEW.igreja_id,'ASSEMBLEIA_GERAL','ASSEMBLEIA_GERAL','CATALOGO','OFICIAL',
      NEW.nome,NEW.sigla,'Assembleia Geral da igreja')
    ON CONFLICT (igreja_id,tipo_padrao) DO NOTHING;
    SELECT id INTO NEW.orgao_id FROM orgao_interno WHERE igreja_id=NEW.igreja_id AND tipo_padrao='ASSEMBLEIA_GERAL';
  END IF;
  SELECT * INTO STRICT origem FROM orgao_interno WHERE id=NEW.orgao_id AND igreja_id=NEW.igreja_id;
  IF (NEW.tipo='ASSEMBLEIA_GERAL') <> (origem.tipo='ASSEMBLEIA_GERAL') THEN
    RAISE EXCEPTION 'Tipo documental incompatível com o órgão' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vincular_contexto_institucional BEFORE INSERT OR UPDATE OF tipo, orgao_id, igreja_id ON contexto_secretaria
FOR EACH ROW EXECUTE FUNCTION vincular_contexto_institucional();
UPDATE contexto_secretaria SET orgao_id = NULL WHERE tipo='ASSEMBLEIA_GERAL' AND orgao_id IS NULL;
ALTER TABLE contexto_secretaria ALTER COLUMN orgao_id SET NOT NULL;

-- Um retrato por versão conserva também os IDs de cargo que modelos publicados referenciam.
CREATE FUNCTION configurar_orgao_inicial(alvo text, destino text, regras jsonb, referencia text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orgao_interno%ROWTYPE;
BEGIN
  SELECT * INTO STRICT o FROM orgao_interno WHERE id=alvo AND igreja_id=destino FOR UPDATE;
  INSERT INTO contexto_secretaria(id,igreja_id,orgao_id,tipo,nome,sigla)
    SELECT gen_random_uuid()::text,destino,alvo,
      (CASE WHEN o.tipo='ASSEMBLEIA_GERAL' THEN 'ASSEMBLEIA_GERAL' ELSE 'ORGAO' END)::contexto_secretaria_tipo,
      o.nome,coalesce(o.sigla,left(o.nome,40))
    ON CONFLICT (orgao_id) DO NOTHING;
  INSERT INTO versao_orgao(id,igreja_id,orgao_id,numero,inicio,fonte,configuracao)
    SELECT gen_random_uuid()::text,destino,alvo,1,CURRENT_DATE,referencia,
      regras || jsonb_build_object('constituicao',o.constituicao,'cargos',coalesce((
        SELECT jsonb_agg(jsonb_build_object('id',id,'codigo',codigo,'nome',nome,'funcao',funcao,
          'permite_acumulacao',permite_acumulacao,'ativo',ativo) ORDER BY codigo)
        FROM cargo_orgao WHERE igreja_id=destino AND orgao_id=alvo),'[]'::jsonb))
    ON CONFLICT (orgao_id,numero) DO NOTHING;
END $$;

CREATE FUNCTION instalar_estrutura_institucional(destino text, apenas_tipo text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  item record;
  alvo text;
  tipo_alvo orgao_tipo;
  candidatos text[];
  cargo text;
  cargos text[];
  regras jsonb;
  referencia text;
BEGIN
  PERFORM 1 FROM igreja WHERE id=destino FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Igreja inexistente'; END IF;
  FOR item IN SELECT * FROM (VALUES
    ('ASSEMBLEIA_GERAL','Assembleia Geral','AG','MESA_POR_REUNIAO'),
    ('CONSELHO','Conselho','CONS','EXERCICIO_PRESBITERAL'),
    ('JUNTA','Junta Diaconal','JD','MANDATO_DIACONAL'),
    ('UCP','União de Crianças Presbiterianas','UCP','ADESAO'),
    ('UPA','União Presbiteriana de Adolescentes','UPA','ADESAO'),
    ('UMP','União de Mocidade Presbiteriana','UMP','ADESAO'),
    ('SAF','Sociedade Auxiliadora Feminina','SAF','ADESAO'),
    ('UPH','União Presbiteriana de Homens','UPH','ADESAO')
  ) AS catalogo(chave,nome,sigla,composicao) WHERE apenas_tipo IS NULL OR chave=apenas_tipo LOOP
    tipo_alvo := CASE WHEN item.composicao='ADESAO' THEN 'SOCIEDADE_INTERNA' ELSE item.chave END;
    SELECT id INTO alvo FROM orgao_interno WHERE igreja_id=destino AND tipo_padrao=item.chave;
    IF alvo IS NULL AND tipo_alvo IN ('CONSELHO','JUNTA') THEN
      SELECT array_agg(id ORDER BY id) INTO candidatos FROM orgao_interno WHERE igreja_id=destino AND tipo=tipo_alvo;
      IF cardinality(candidatos)>1 THEN
        -- Identidades históricas ambíguas continuam disponíveis para reconciliação.
        RAISE NOTICE 'Conferir identidades % da igreja %',item.chave,destino;
        CONTINUE;
      END IF;
      alvo := candidatos[1];
      UPDATE orgao_interno SET tipo_padrao=item.chave WHERE igreja_id=destino AND id=alvo;
    END IF;
    IF alvo IS NULL THEN
      INSERT INTO orgao_interno(id,igreja_id,tipo,tipo_padrao,origem,constituicao,nome,sigla,finalidade,ativo)
      VALUES (gen_random_uuid()::text,destino,tipo_alvo,item.chave,'CATALOGO',
        (CASE WHEN tipo_alvo='SOCIEDADE_INTERNA' THEN 'ELEICAO' ELSE 'OFICIAL' END)::orgao_constituicao,
        item.nome,item.sigla,item.nome,tipo_alvo<>'SOCIEDADE_INTERNA') RETURNING id INTO alvo;
    END IF;

    -- Repetir a instalação não altera configurações já adotadas pela igreja.
    IF EXISTS (SELECT 1 FROM versao_orgao WHERE orgao_id=alvo AND numero=1) THEN CONTINUE; END IF;
    regras := jsonb_build_object('composicao',item.composicao);
    cargos := ARRAY['PRESIDENTE','VICE_PRESIDENTE','SECRETARIO','SEGUNDO_SECRETARIO','TESOUREIRO'];
    IF tipo_alvo='ASSEMBLEIA_GERAL' THEN
      cargos := ARRAY[]::text[];
      regras := regras || '{"funcoes_reuniao":["PRESIDENTE_MESA","SECRETARIO_MESA"],"contexto_atos":"REUNIAO_DA_ASSEMBLEIA"}';
      referencia := 'SC/IPB 2026 DOC. CLIV';
    ELSIF tipo_alvo IN ('CONSELHO','JUNTA') THEN
      regras := regras || jsonb_build_object('mandato_anos',5,'cargo_prazo_sugerido_meses',
        CASE WHEN tipo_alvo='CONSELHO' THEN 60 ELSE 12 END,
        'atos',jsonb_build_object('eleicao_integrante','ASSEMBLEIA_GERAL','posse_integrante','CONSELHO',
          'eleicao_cargo',item.chave,'posse_cargo',item.chave));
      IF tipo_alvo='CONSELHO' THEN
        cargos := array_remove(cargos,'PRESIDENTE');
        regras := regras || '{"designacao":"PRESBITERO","subtipos":["REGENTE","DOCENTE"],"docente":"VINCULO_PASTORAL","presidencia":"PRESIDENCIA_CONSELHO","cargo_prazo_maximo_meses":60,"tesouraria":"OFICIAL_OU_MEMBRO_COMUNGANTE"}';
        referencia := 'Manual Presbiteriano, arts. 33–34 e 54. EC 7/2026';
      ELSE
        regras := regras || '{"designacao":"DIACONO","homologar":"REGIMENTO_LOCAL_DA_JUNTA"}';
        referencia := 'Manual Presbiteriano, modelo de regimento da Junta Diaconal';
      END IF;
    ELSE
      regras := regras || jsonb_build_object('homologar','GUIA_ESPECIFICO_E_REGRA_LOCAL','conselheiro','CONSELHO','cargo_prazo_sugerido_meses',12,
        'revisao_local',CASE item.chave WHEN 'UCP' THEN 'QUANTIDADE_DE_SECRETARIOS_E_ORIENTACAO'
          WHEN 'UPA' THEN 'TRANSICAO_DA_UCP_E_ORIENTACAO' WHEN 'UMP' THEN 'IDADE_MINIMA_E_DIRETORIA_REDUZIDA'
          WHEN 'SAF' THEN 'DIRETORIA_REDUZIDA_E_FREQUENCIA' ELSE 'MEMBRESIA_E_TEMPO_NA_SOCIEDADE' END,
        'idade_minima_referencia',CASE item.chave WHEN 'UCP' THEN 6 WHEN 'UPA' THEN 12 WHEN 'UMP' THEN 19 ELSE 18 END,
        'idade_maxima_referencia',CASE item.chave WHEN 'UCP' THEN 11 WHEN 'UPA' THEN 18 WHEN 'UMP' THEN 35 END,
        'sexo_referencia',CASE item.chave WHEN 'SAF' THEN 'FEMININO' WHEN 'UPH' THEN 'MASCULINO' END,
        'atos',jsonb_build_object('admissao',item.chave,'adesao',item.chave,'eleicao_cargo',item.chave,
          'aprovacao','CONSELHO','posse_cargo',item.chave));
      referencia := 'GTSI, parte comum e parte específica ' || item.chave || '. Catálogo para homologação';
    END IF;
    FOREACH cargo IN ARRAY cargos LOOP
      IF cargo='SECRETARIO' AND EXISTS (SELECT 1 FROM cargo_orgao WHERE orgao_id=alvo AND codigo='PRIMEIRO_SECRETARIO') THEN CONTINUE; END IF;
      INSERT INTO cargo_orgao(id,igreja_id,orgao_id,codigo,nome,funcao)
      VALUES (gen_random_uuid()::text,destino,alvo,cargo,
        CASE cargo WHEN 'PRESIDENTE' THEN 'Presidente' WHEN 'VICE_PRESIDENTE' THEN 'Vice-presidente'
          WHEN 'SECRETARIO' THEN 'Primeiro secretário' WHEN 'SEGUNDO_SECRETARIO' THEN 'Segundo secretário' ELSE 'Tesoureiro' END,
        CASE WHEN cargo='SEGUNDO_SECRETARIO' THEN 'SECRETARIO' ELSE cargo END)
      ON CONFLICT (orgao_id,codigo) DO NOTHING;
    END LOOP;
    PERFORM configurar_orgao_inicial(alvo,destino,regras,referencia);
  END LOOP;
  -- Inclui ministérios e órgãos históricos pendentes, conservando sua classificação e acervo.
  FOR item IN SELECT id,constituicao FROM orgao_interno WHERE apenas_tipo IS NULL AND igreja_id=destino AND tipo_padrao IS NULL LOOP
    PERFORM configurar_orgao_inicial(item.id,destino,jsonb_build_object('composicao',item.constituicao),'Cadastro institucional local');
  END LOOP;
END $$;

SELECT instalar_estrutura_institucional(id) FROM igreja ORDER BY id;
COMMIT;
