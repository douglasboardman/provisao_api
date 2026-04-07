import { PrismaClient, usuarios_perfil as Perfil, estados_brasil as Estados } from "@prisma/client";
import * as bcrypt from 'bcrypt';

// Instancia o Prisma Client
const prisma = new PrismaClient();

async function main() {
    console.log('Iniciando o processo de seeding...');

    // 1. Cria ou atualiza a Igreja Matriz
    // O CNPJ é passado apenas com números para respeitar o limite do VarChar(14)
    const cnpjIgreja = '08038534000119';
    const igreja = await prisma.igreja.upsert({
        where: { cnpj: cnpjIgreja },
        update: {},
        create: {
            cnpj: cnpjIgreja,
            nome: 'Igreja Presbiteriana de Uruguaiana',
            congregacao: false,
            vinculada_a: null,
            logradouro: 'R. Gen. Câmara',
            numero: '2786',
            complemento: null,
            bairro: 'Centro',
            cidade: 'Uruguaiana',
            estado: Estados.RS, // Utiliza o Enum de estados
            cep: '97503293',    // Apenas números para respeitar o VarChar(8)
            ativa: true,
        }
    });

    console.log(`Igreja "${igreja.nome}" criada/confirmada com sucesso (ID: ${igreja.id}).`);

    // 2. Prepara a senha do Administrador
    const saltRounds = 10;
    const adminPassword = 'admin123';
    const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);
    console.log('Senha para o admin criptografada com sucesso.');

    // 3. Cria ou atualiza o Usuário Administrador vinculado à Igreja
    const emailAdmin = 'douglas.boardman@gmail.com';
    const adminUser = await prisma.usuarios.upsert({
        // Utiliza a chave composta gerada pelo Prisma devido ao @@unique([igreja_id, email_login])
        where: {
            igreja_id_email_login: {
                igreja_id: igreja.id,
                email_login: emailAdmin
            }
        },
        update: {},
        create: {
            igreja_id: igreja.id, // Injeta a chave estrangeira da igreja recém-criada
            email_login: emailAdmin,
            nome_usuario: 'Administrador do Sistema',
            senha_hash: hashedPassword,
            perfil: Perfil.ADMINISTRADOR,
            ativo: true
        }
    });

    console.log(`Usuário "${adminUser.nome_usuario}" criado/confirmado com sucesso.`);
    console.log(`Seeding concluído.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });