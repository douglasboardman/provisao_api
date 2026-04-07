import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
    // Inicializa a conexão com o Banco de Dados da aplicação
    async onModuleInit() {
        await this.$connect();
    }
}