import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class LogsService {
    constructor(private readonly prisma: PrismaService) { }

    async findAll(igreja_id: string, page = 1) {
        const take = 50;
        const skip = (page - 1) * take;
        const where = { igreja_id };
        const [data, total] = await Promise.all([
            this.prisma.logs_atividades.findMany({
                where, skip, take,
                orderBy: { created_at: 'desc' },
                include: { usuarios: { select: { nome_usuario: true, email_login: true } } },
            }),
            this.prisma.logs_atividades.count({ where }),
        ]);
        return { data, total, page, totalPages: Math.ceil(total / take) };
    }
}