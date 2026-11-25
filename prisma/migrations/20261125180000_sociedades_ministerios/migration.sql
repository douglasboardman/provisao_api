ALTER TABLE orgao_interno ADD COLUMN gestao_presidencial boolean NOT NULL DEFAULT false;
ALTER TABLE orgao_interno ADD CONSTRAINT orgao_gestao_presidencial_ministerio
  CHECK (NOT gestao_presidencial OR tipo = 'UNIDADE_MINISTERIAL');

ALTER TABLE membro_orgao ADD COLUMN categoria_participacao varchar(24);
ALTER TABLE membro_orgao ADD CONSTRAINT membro_categoria_participacao
  CHECK (categoria_participacao IN ('LOCAL', 'ESCOLA_DOMINICAL', 'AUTORIZACAO_CONSELHO', 'COOPERADOR'));
