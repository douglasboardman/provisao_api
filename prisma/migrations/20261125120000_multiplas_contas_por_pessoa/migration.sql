BEGIN;

CREATE INDEX "usuarios_pessoa_id_igreja_id_idx" ON "usuarios" ("pessoa_id", "igreja_id");
DROP INDEX "usuarios_pessoa_id_igreja_id_key";
DROP INDEX "usuarios_pessoa_id_key";

COMMIT;
