BEGIN;
UPDATE cargo_orgao c SET nome = 'Primeiro secretário'
FROM orgao_interno o WHERE o.id = c.orgao_id AND o.tipo IN ('CONSELHO', 'JUNTA')
  AND c.codigo = 'SECRETARIO' AND c.nome = 'Secretário';
INSERT INTO cargo_orgao (id, igreja_id, orgao_id, codigo, nome, funcao)
SELECT gen_random_uuid()::text, o.igreja_id, o.id, s.codigo, s.nome, 'SECRETARIO'
FROM orgao_interno o CROSS JOIN (VALUES ('SECRETARIO', 'Primeiro secretário'), ('SEGUNDO_SECRETARIO', 'Segundo secretário')) AS s(codigo, nome)
WHERE o.ativo AND o.tipo IN ('CONSELHO', 'JUNTA')
  AND NOT (s.codigo = 'SECRETARIO' AND EXISTS (SELECT 1 FROM cargo_orgao c WHERE c.orgao_id = o.id AND c.codigo = 'PRIMEIRO_SECRETARIO'))
ON CONFLICT (orgao_id, codigo) DO NOTHING;
COMMIT;
