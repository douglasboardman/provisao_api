-- Aditiva: contas existentes recebem geração zero. JWTs sem geração não são aceitos pelo novo guard.
ALTER TABLE "usuarios" ADD COLUMN "auth_version" INTEGER NOT NULL DEFAULT 0;
