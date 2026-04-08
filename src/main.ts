import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ZodValidationPipe } from 'nestjs-zod';
import { PrismaExceptionFilter } from './core/filters/prisma-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    credentials: true,
  });
  // Filtro global: converte erros Prisma em respostas HTTP semânticas
  app.useGlobalFilters(new PrismaExceptionFilter());
  // Aplica o ZodValidationPipe globalmente na aplicação
  app.useGlobalPipes(new ZodValidationPipe());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
