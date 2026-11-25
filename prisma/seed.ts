import {
  PrismaClient,
  usuarios_perfil as Perfil,
  estados_brasil as Estados,
  tipo_regra_enum as TipoRegra,
} from "@prisma/client";
import * as bcrypt from "bcrypt";

async function main(prisma: PrismaClient) {
  console.log("Iniciando o processo de seeding...");

  // 1. Cria ou atualiza a Igreja Matriz
  // O CNPJ é passado apenas com números para respeitar o limite do VarChar(14)
  const cnpjIgreja = "08038534000119";
  const igreja = await prisma.$transaction(async tx => {
    const matriz = await tx.igreja.upsert({
      where: { cnpj: cnpjIgreja },
      update: {},
      create: {
        cnpj: cnpjIgreja,
        nome: "Igreja Presbiteriana de Uruguaiana",
        congregacao: false,
        vinculada_a: null,
        logradouro: "R. Gen. Câmara",
        numero: "2786",
        complemento: null,
        bairro: "Centro",
        cidade: "Uruguaiana",
        estado: Estados.RS, // Utiliza o Enum de estados
        cep: "97503293", // Apenas números para respeitar o VarChar(8)
        ativa: true,
      },
    });
    await tx.$executeRaw`SELECT instalar_estrutura_institucional(${matriz.id})`;
    return matriz;
  });

  console.log(
    `Igreja "${igreja.nome}" criada/confirmada com sucesso (ID: ${igreja.id}).`,
  );

  // 2. Popula a tabela de tratamentos
  const tratamentos = [
    { descricao: "Senhor", abreviacao: "Sr." },
    { descricao: "Senhora", abreviacao: "Sra." },
    { descricao: "Irmão", abreviacao: "Ir." },
    { descricao: "Irmã", abreviacao: "Irmã" },
    { descricao: "Reverendo", abreviacao: "Rev." },
    { descricao: "Presbítero", abreviacao: "Presb." },
    { descricao: "Diácono", abreviacao: "Diác." },
    { descricao: "Pastor", abreviacao: "Pr." },
    { descricao: "Missionário", abreviacao: "Miss." },
    { descricao: "Missionária", abreviacao: "Missa." },
    { descricao: "Doutor", abreviacao: "Dr." },
    { descricao: "Doutora", abreviacao: "Dra." },
  ];

  for (const t of tratamentos) {
    const exists = await prisma.tratamentos.findFirst({
      where: { descricao: t.descricao },
    });
    if (!exists) {
      await prisma.tratamentos.create({ data: t });
    }
  }

  console.log(
    `${tratamentos.length} tratamentos verificados/criados com sucesso.`,
  );

  // 3. Prepara a senha do Administrador
  const saltRounds = 10;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 12) {
    throw new Error("Defina SEED_ADMIN_PASSWORD com pelo menos 12 caracteres.");
  }
  const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);
  console.log("Senha para o admin criptografada com sucesso.");

  // 3. Cria ou atualiza o Usuário Administrador vinculado à Igreja
  const emailAdmin = process.env.SEED_ADMIN_EMAIL || "douglas.boardman@gmail.com";
  const adminUser = await prisma.usuarios.upsert({
    // Utiliza a chave composta gerada pelo Prisma devido ao @@unique([igreja_id, email_login])
    where: {
      igreja_id_email_login: {
        igreja_id: igreja.id,
        email_login: emailAdmin,
      },
    },
    update: {},
    create: {
      igreja_id: igreja.id, // Injeta a chave estrangeira da igreja recém-criada
      email_login: emailAdmin,
      nome_usuario: "Administrador do Sistema",
      senha_hash: hashedPassword,
      perfil: Perfil.ADMINISTRADOR,
      ativo: true,
    },
  });

  console.log(
    `Usuário "${adminUser.nome_usuario}" criado/confirmado com sucesso.`,
  );

  await seedRegrasRelacaoEnum(prisma);

  console.log(`Seeding concluído.`);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  main(prisma)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

export async function seedRegrasRelacaoEnum(prisma: PrismaClient) {
  const grupos = [
    {
      modulo: "membresia",
      nome: "Motivações de Admissão",
      descricao:
        "Define quais motivações estão disponíveis ao registrar uma admissão",
      tipo_regra: TipoRegra.FILTRO,
      enum_classificador: "membresia_tipo_evento",
      enum_classificado: "membresia_motivacao_evento",
      valores: [
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "PROFISSAO_DE_FE",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "PROFISSAO_DE_FE_E_BATISMO",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "CARTA_DE_TRANSFERENCIA_RECEBIDA",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "JURISDICAO_A_PEDIDO",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "JURISDICAO_EX_OFFICIO",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "RESTAURACAO",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "DESIGNACAO_PRESBITERIO",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "BATISMO_NA_INFANCIA",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "TRANSFERENCIA_PAIS_OU_RESPONSAVEIS",
        },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado:
            "JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS",
        },
      ],
    },
    {
      modulo: "membresia",
      nome: "Motivações de Demissão",
      descricao:
        "Define quais motivações estão disponíveis ao registrar uma demissão",
      tipo_regra: TipoRegra.FILTRO,
      enum_classificador: "membresia_tipo_evento",
      enum_classificado: "membresia_motivacao_evento",
      valores: [
        {
          valor_classificador: "DEMISSAO",
          valor_classificado: "EXCLUSAO_POR_DISCIPLINA",
        },
        {
          valor_classificador: "DEMISSAO",
          valor_classificado: "EXCLUSAO_A_PEDIDO",
        },
        {
          valor_classificador: "DEMISSAO",
          valor_classificado: "EXCLUSAO_POR_AUSENCIA",
        },
        {
          valor_classificador: "DEMISSAO",
          valor_classificado: "CARTA_DE_TRANSFERENCIA_CONCEDIDA",
        },
        {
          valor_classificador: "DEMISSAO",
          valor_classificado: "JURISDICAO_ASSUMIDA",
        },
        {
          valor_classificador: "DEMISSAO",
          valor_classificado: "FALECIMENTO",
        },
        {
          valor_classificador: "DEMISSAO",
          valor_classificado:
            "CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS",
        },
        {
          valor_classificador: "DEMISSAO",
          valor_classificado: "DEZOITO_ANOS_COMPLETOS",
        },
        {
          valor_classificador: "DEMISSAO",
          valor_classificado: "SOLICITACAO_PAIS_OUTRA_COMUNIDADE",
        },
      ],
    },
    {
      modulo: "membresia",
      nome: "Motivações de Mudança de Rol",
      descricao:
        "Define quais motivações estão disponíveis ao registrar uma mudança de rol (conjunto base)",
      tipo_regra: TipoRegra.FILTRO,
      enum_classificador: "membresia_tipo_evento",
      enum_classificado: "membresia_motivacao_evento",
      valores: [
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "PROFISSAO_DE_FE",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "PROFISSAO_DE_FE_E_BATISMO",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "CARTA_DE_TRANSFERENCIA_RECEBIDA",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "JURISDICAO_A_PEDIDO",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "JURISDICAO_EX_OFFICIO",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "RESTAURACAO",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "DESIGNACAO_PRESBITERIO",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "BATISMO_NA_INFANCIA",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "TRANSFERENCIA_PAIS_OU_RESPONSAVEIS",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado:
            "JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "PARADEIRO_IGNORADO",
        },
      ],
    },
    {
      modulo: "membresia",
      nome: "Rols de Admissão",
      descricao:
        "Define quais rols estão disponíveis para seleção ao registrar uma admissão",
      tipo_regra: TipoRegra.FILTRO,
      enum_classificador: "membresia_tipo_evento",
      enum_classificado: "membresia_rol",
      valores: [
        { valor_classificador: "ADMISSAO", valor_classificado: "COMUNGANTES" },
        {
          valor_classificador: "ADMISSAO",
          valor_classificado: "NAO_COMUNGANTES",
        },
      ],
    },
    {
      modulo: "membresia",
      nome: "Rols de Mudança de Rol",
      descricao:
        "Define quais rols estão disponíveis como destino ao registrar uma mudança de rol",
      tipo_regra: TipoRegra.FILTRO,
      enum_classificador: "membresia_tipo_evento",
      enum_classificado: "membresia_rol",
      valores: [
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "COMUNGANTES",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "NAO_COMUNGANTES",
        },
        {
          valor_classificador: "MUDANCA_DE_ROL",
          valor_classificado: "ROL_SEPARADO",
        },
      ],
    },
    {
      modulo: "membresia",
      nome: "Rol de Destino por Motivação de Demissão",
      descricao:
        "Determina automaticamente o rol de destino com base na motivação de demissão selecionada",
      tipo_regra: TipoRegra.MAPEAMENTO,
      enum_classificador: "membresia_motivacao_evento",
      enum_classificado: "membresia_rol",
      valores: [
        {
          valor_classificador: "EXCLUSAO_POR_DISCIPLINA",
          valor_classificado: "EXCLUIDOS",
        },
        {
          valor_classificador: "EXCLUSAO_A_PEDIDO",
          valor_classificado: "EXCLUIDOS",
        },
        {
          valor_classificador: "EXCLUSAO_POR_AUSENCIA",
          valor_classificado: "EXCLUIDOS",
        },
        {
          valor_classificador: "CARTA_DE_TRANSFERENCIA_CONCEDIDA",
          valor_classificado: "ROL_SEPARADO",
        },
        {
          valor_classificador: "JURISDICAO_ASSUMIDA",
          valor_classificado: "ROL_SEPARADO",
        },
        {
          valor_classificador: "FALECIMENTO",
          valor_classificado: "ROL_SEPARADO",
        },
        {
          valor_classificador:
            "CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS",
          valor_classificado: "ROL_SEPARADO",
        },
        {
          valor_classificador: "DEZOITO_ANOS_COMPLETOS",
          valor_classificado: "ROL_SEPARADO",
        },
        {
          valor_classificador: "SOLICITACAO_PAIS_OUTRA_COMUNIDADE",
          valor_classificado: "ROL_SEPARADO",
        },
      ],
    },
    {
      modulo: "membresia",
      nome: "Motivações por Rol de Destino",
      descricao:
        "Filtra as motivações disponíveis conforme o rol de destino selecionado em uma mudança de rol",
      tipo_regra: TipoRegra.FILTRO,
      enum_classificador: "membresia_rol",
      enum_classificado: "membresia_motivacao_evento",
      valores: [
        {
          valor_classificador: "ROL_SEPARADO",
          valor_classificado: "PARADEIRO_IGNORADO",
        },
        ...["COMUNGANTES", "NAO_COMUNGANTES"].flatMap((rol) =>
          [
            "PROFISSAO_DE_FE",
            "PROFISSAO_DE_FE_E_BATISMO",
            "CARTA_DE_TRANSFERENCIA_RECEBIDA",
            "JURISDICAO_A_PEDIDO",
            "JURISDICAO_EX_OFFICIO",
            "RESTAURACAO",
            "DESIGNACAO_PRESBITERIO",
            "BATISMO_NA_INFANCIA",
            "TRANSFERENCIA_PAIS_OU_RESPONSAVEIS",
            "JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS",
          ].map((mot) => ({
            valor_classificador: rol,
            valor_classificado: mot,
          })),
        ),
      ],
    },
  ];

  for (const { valores, ...grupo } of grupos) {
    const regra = await prisma.regras_relacao_enum.upsert({
      where: { modulo_nome: { modulo: grupo.modulo, nome: grupo.nome } },
      update: {},
      create: grupo,
    });

    const existingCount = await prisma.relacao_enum_valores.count({
      where: { regra_id: regra.id },
    });

    if (existingCount === 0) {
      await prisma.relacao_enum_valores.createMany({
        data: valores.map((v) => ({ regra_id: regra.id, ...v })),
      });
    }
  }

  console.log("Seed de regras de relação de enum realizado com sucesso!");
}
