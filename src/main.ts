import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ZodValidationPipe } from 'nestjs-zod';
import { etapasPorIgreja } from './feature-flags/feature-flags';

async function bootstrap() {
  etapasPorIgreja(process.env.PROVISAO_ROLLOUT);
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    credentials: true,
  });
  // Aplica o ZodValidationPipe globalmente na aplicação
  app.useGlobalPipes(new ZodValidationPipe());
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}
bootstrap();
