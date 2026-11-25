import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { ZodValidationPipe } from 'nestjs-zod';
import { etapasPorIgreja } from './feature-flags/feature-flags';

async function bootstrap() {
  etapasPorIgreja(process.env.PROVISAO_ROLLOUT);
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    credentials: true,
  });
  app.use(['/minha-assembleia/salvar', '/secretaria/atas-legadas', '/secretaria/modelos', '/secretaria/documentos'], json({ limit: '2mb' }));
  app.use(json());
  app.use(urlencoded({ extended: true }));
  // Aplica o ZodValidationPipe globalmente na aplicação
  app.useGlobalPipes(new ZodValidationPipe());
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}
bootstrap();
