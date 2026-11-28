-- Complementa os modelos padrão em contextos existentes e futuros.
BEGIN;
CREATE FUNCTION instalar_modelos_reuniao_assuntos_diversos(ctx contexto_secretaria)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO modelo_reuniao (igreja_id, contexto_id, finalidade, configuracao)
  SELECT ctx.igreja_id, ctx.id, 'Outros assuntos eclesiásticos, administrativos, processuais, sobre mandato de oficiais e exonerações', m.configuracao
  FROM orgao_interno o
  JOIN (VALUES
('ASSEMBLEIA_GERAL','{"tipo": "Extraordinária", "segunda": "Qualquer número", "natureza": "Mista", "primeira": "1/3", "colegiado": "Colegiado", "observacao": "Finalidade genérica para pautas extraordinárias diversas, dentro da competência da Assembleia. Observar capacidade civil conforme a matéria. Assuntos processuais abrangem comunicações e pronunciamentos cabíveis à Assembleia; o modelo não atribui competência de tribunal.", "referencia": "Membros comungantes", "obrigatoria": false, "minimo_anual": null, "fundamentacao": "CI/IPB, arts. 9º, 10 e 13. Modelo de Estatuto, arts. 16 a 22.", "periodicidade": "Conforme a necessidade", "antecedencia_dias": 7, "intervalo_minutos": 10080, "orgaos_participantes": []}'::jsonb),
('CONSELHO','{"tipo": "Ordinária", "segunda": "Não prevista", "natureza": "Mista", "primeira": "Composição e maioria absoluta", "colegiado": "Colegiado", "observacao": "Modelo ordinário para pauta mista. Exige composição regular e maioria absoluta para abranger assuntos administrativos. Conferir impedimentos, suspeições e requisitos próprios de cada matéria. Manter a frequência trimestral do Conselho como um todo.", "referencia": "Integrantes do órgão/unidade", "obrigatoria": false, "minimo_anual": null, "fundamentacao": "CI/IPB, arts. 75 a 83. Modelo de Estatuto, arts. 31 a 35. Código de Disciplina, arts. 18 e 19, quando houver matéria processual.", "periodicidade": "Conforme a necessidade", "antecedencia_dias": null, "intervalo_minutos": null, "orgaos_participantes": []}'::jsonb)
  ) m(tipo, configuracao) ON m.tipo=o.tipo_padrao
  WHERE o.id=ctx.orgao_id AND o.igreja_id=ctx.igreja_id
  ON CONFLICT (contexto_id, finalidade) DO NOTHING;
$$;
SELECT instalar_modelos_reuniao_assuntos_diversos(c) FROM contexto_secretaria c;
CREATE FUNCTION novos_modelos_reuniao_assuntos_diversos() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM instalar_modelos_reuniao_assuntos_diversos(NEW);
  RETURN NEW;
END;
$$;
CREATE TRIGGER novos_modelos_reuniao_assuntos_diversos
  AFTER INSERT ON contexto_secretaria FOR EACH ROW
  EXECUTE FUNCTION novos_modelos_reuniao_assuntos_diversos();
COMMIT;
