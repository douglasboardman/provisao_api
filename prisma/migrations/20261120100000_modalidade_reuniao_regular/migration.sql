ALTER TABLE "reuniao"
  ADD CONSTRAINT "reuniao_modalidade_valida"
  CHECK ("modalidade" IN ('ORDINARIA', 'EXTRAORDINARIA', 'REGULAR', 'AGO', 'AGE'));
