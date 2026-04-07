-- CreateEnum
CREATE TYPE "vinculos_membresia_rol" AS ENUM ('COMUNGANTE', 'NAO_COMUNGANTE', 'ROL_SEPARADO');

-- CreateEnum
CREATE TYPE "logs_atividades_acao" AS ENUM ('CRIACAO', 'ATUALIZACAO', 'EXCLUSAO', 'LOGIN_SUCESSO', 'LOGIN_FALHA');

-- CreateEnum
CREATE TYPE "lancamentos_tipo_transacao" AS ENUM ('RECEITA', 'DESPESA');

-- CreateEnum
CREATE TYPE "usuarios_perfil" AS ENUM ('ADMINISTRADOR', 'GESTOR', 'TESOUREIRO', 'OPERADOR', 'AUDITOR');

-- CreateEnum
CREATE TYPE "vinculos_membresia_forma_admissao" AS ENUM ('TRANSFERENCIA', 'BATISMO', 'PROFISSAO_DE_FE');

-- CreateEnum
CREATE TYPE "pessoas_sexo" AS ENUM ('MASCULINO', 'FEMININO');

-- CreateEnum
CREATE TYPE "pessoas_estado_civil" AS ENUM ('SOLTEIRO', 'CASADO', 'DIVORCIADO', 'VIUVO');

-- CreateEnum
CREATE TYPE "vinculos_membresia_modalidade_exclusao" AS ENUM ('TRANSFERENCIA', 'EXCOMUNHAO', 'MUDANCA_ROL');

-- CreateEnum
CREATE TYPE "tipo_conta" AS ENUM ('CORRENTE', 'POUPANÇA', 'INVESTIMENTO', 'CAIXA');

-- CreateTable
CREATE TABLE "contas" (
    "id" TEXT NOT NULL,
    "descricao" VARCHAR(100) NOT NULL,
    "banco" VARCHAR(100),
    "tipo_conta" "tipo_conta" NOT NULL,
    "num_conta" VARCHAR(15),
    "agencia" VARCHAR(7),
    "saldo_inicial" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "cor_hex" VARCHAR(7),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "descritivos_despesa" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "tipo_despesa_id" INTEGER NOT NULL,
    "cor_hex" VARCHAR(7),
    "requer_pessoa" BOOLEAN NOT NULL DEFAULT false,
    "requer_destinacao" BOOLEAN NOT NULL DEFAULT false,
    "requer_conta" BOOLEAN NOT NULL DEFAULT false,
    "requer_comprovante" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "descritivos_despesa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "descritivos_receita" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "tipo_receita_id" INTEGER NOT NULL,
    "cor_hex" VARCHAR(7),
    "requer_pessoa" BOOLEAN NOT NULL DEFAULT false,
    "requer_destinacao" BOOLEAN NOT NULL DEFAULT false,
    "requer_conta" BOOLEAN NOT NULL DEFAULT false,
    "requer_comprovante" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "descritivos_receita_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destinacoes" (
    "id" TEXT NOT NULL,
    "nome" VARCHAR(255) NOT NULL,
    "descricao_detalhada" TEXT,
    "cor_hex" VARCHAR(7),
    "responsavel_pessoa_id" TEXT NOT NULL,
    "data_inicio" DATE NOT NULL,
    "data_fim" DATE,
    "orcamento_receita" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "orcamento_despesa" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "destinacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grupos_familiares" (
    "id" TEXT NOT NULL,
    "nome_familia" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grupos_familiares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lancamentos" (
    "id" TEXT NOT NULL,
    "data_transacao" DATE NOT NULL,
    "valor" DECIMAL(10,2) NOT NULL,
    "tipo_transacao" "lancamentos_tipo_transacao" NOT NULL,
    "conta_id" TEXT NOT NULL,
    "destinacao_id" TEXT,
    "descritivo_receita_id" INTEGER,
    "descritivo_despesa_id" INTEGER,
    "pessoa_id" TEXT,
    "observacao" TEXT,
    "comprovante_url" VARCHAR(255),
    "usuario_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lancamentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs_atividades" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "ip_address" VARCHAR(45),
    "acao" "logs_atividades_acao" NOT NULL,
    "tabela_afetada" VARCHAR(100) NOT NULL,
    "registro_id" INTEGER,
    "dados_antigos" JSONB,
    "dados_novos" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_atividades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pessoas" (
    "id" TEXT NOT NULL,
    "nome_completo" VARCHAR(255) NOT NULL,
    "url_foto" VARCHAR(255),
    "cpf" VARCHAR(11),
    "data_nascimento" DATE NOT NULL,
    "sexo" "pessoas_sexo" NOT NULL,
    "estado_civil" "pessoas_estado_civil",
    "email" VARCHAR(255),
    "telefone_celular" VARCHAR(15),
    "cep" VARCHAR(8),
    "logradouro" VARCHAR(255),
    "numero" VARCHAR(20),
    "complemento" VARCHAR(100),
    "bairro" VARCHAR(100),
    "cidade" VARCHAR(100),
    "estado" VARCHAR(2),
    "grupo_familiar_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pessoas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tipos_despesa" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "cor_hex" VARCHAR(7),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tipos_despesa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tipos_receita" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "cor_hex" VARCHAR(7),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tipos_receita_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios" (
    "id" TEXT NOT NULL,
    "nome_usuario" VARCHAR(255) NOT NULL,
    "email_login" VARCHAR(255) NOT NULL,
    "url_imagem_perfil" VARCHAR(255),
    "senha_hash" VARCHAR(255) NOT NULL,
    "perfil" "usuarios_perfil" NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vinculos_membresia" (
    "id" TEXT NOT NULL,
    "pessoa_id" TEXT NOT NULL,
    "rol" "vinculos_membresia_rol" NOT NULL,
    "data_admissao" DATE NOT NULL,
    "forma_admissao" "vinculos_membresia_forma_admissao" NOT NULL,
    "igreja_origem" VARCHAR(255),
    "data_exclusao" DATE,
    "modalidade_exclusao" "vinculos_membresia_modalidade_exclusao",
    "igreja_destino" VARCHAR(255),
    "vinculo_ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vinculos_membresia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "descritivos_despesa_nome_UNIQUE" ON "descritivos_despesa"("nome");

-- CreateIndex
CREATE INDEX "tipo_despesa_id" ON "descritivos_despesa"("tipo_despesa_id");

-- CreateIndex
CREATE UNIQUE INDEX "descritivos_receita_nome_UNIQUE" ON "descritivos_receita"("nome");

-- CreateIndex
CREATE INDEX "tipo_receita_id" ON "descritivos_receita"("tipo_receita_id");

-- CreateIndex
CREATE INDEX "responsavel_pessoa_id" ON "destinacoes"("responsavel_pessoa_id");

-- CreateIndex
CREATE INDEX "lancamentos_conta_id" ON "lancamentos"("conta_id");

-- CreateIndex
CREATE INDEX "lancamentos_descritivo_despesa_id" ON "lancamentos"("descritivo_despesa_id");

-- CreateIndex
CREATE INDEX "lancamentos_descritivo_receita_id" ON "lancamentos"("descritivo_receita_id");

-- CreateIndex
CREATE INDEX "lancamentos_destinacao_id" ON "lancamentos"("destinacao_id");

-- CreateIndex
CREATE INDEX "lancamentos_pessoa_id" ON "lancamentos"("pessoa_id");

-- CreateIndex
CREATE INDEX "lancamentos_usuario_id" ON "lancamentos"("usuario_id");

-- CreateIndex
CREATE INDEX "logs_atividades_usuario_id" ON "logs_atividades"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "cpf_UNIQUE" ON "pessoas"("cpf");

-- CreateIndex
CREATE UNIQUE INDEX "email_UNIQUE" ON "pessoas"("email");

-- CreateIndex
CREATE INDEX "grupo_familiar_id" ON "pessoas"("grupo_familiar_id");

-- CreateIndex
CREATE UNIQUE INDEX "tipos_despesa_nome_UNIQUE" ON "tipos_despesa"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "tipos_receita_nome_UNIQUE" ON "tipos_receita"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "nome_usuario_UNIQUE" ON "usuarios"("nome_usuario");

-- CreateIndex
CREATE UNIQUE INDEX "email_login_UNIQUE" ON "usuarios"("email_login");

-- CreateIndex
CREATE INDEX "vinculos_membresia_pessoa_id" ON "vinculos_membresia"("pessoa_id");

-- AddForeignKey
ALTER TABLE "descritivos_despesa" ADD CONSTRAINT "descritivos_despesa_ibfk_1" FOREIGN KEY ("tipo_despesa_id") REFERENCES "tipos_despesa"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "descritivos_receita" ADD CONSTRAINT "descritivos_receita_ibfk_1" FOREIGN KEY ("tipo_receita_id") REFERENCES "tipos_receita"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "destinacoes" ADD CONSTRAINT "destinacoes_ibfk_1" FOREIGN KEY ("responsavel_pessoa_id") REFERENCES "pessoas"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_1" FOREIGN KEY ("conta_id") REFERENCES "contas"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_2" FOREIGN KEY ("destinacao_id") REFERENCES "destinacoes"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_3" FOREIGN KEY ("descritivo_receita_id") REFERENCES "descritivos_receita"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_4" FOREIGN KEY ("descritivo_despesa_id") REFERENCES "descritivos_despesa"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_5" FOREIGN KEY ("pessoa_id") REFERENCES "pessoas"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_ibfk_6" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "logs_atividades" ADD CONSTRAINT "logs_atividades_ibfk_1" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_ibfk_1" FOREIGN KEY ("grupo_familiar_id") REFERENCES "grupos_familiares"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vinculos_membresia" ADD CONSTRAINT "vinculos_membresia_ibfk_1" FOREIGN KEY ("pessoa_id") REFERENCES "pessoas"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
