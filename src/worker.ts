import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { OutboxService } from './outbox/outbox.service';
import { etapasPorIgreja, featureEnabled } from './feature-flags/feature-flags';
import { NotificacoesMandatoService } from './oficiais/notificacoes-mandato.service';
import { MfaService } from './mfa/mfa.service';
import { ExpedicaoWorkerService } from './secretaria/expedicao-worker.service';
import { RascunhosService } from './secretaria/rascunhos.service';

const aguardar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function bootstrap() {
  etapasPorIgreja(process.env.PROVISAO_ROLLOUT);
  const app = await NestFactory.createApplicationContext(AppModule);
  const outbox = app.get(OutboxService);
  // Valida a chave antes de iniciar e falha sem expor seu valor.
  outbox.seal('verificacao', 'inicializacao');
  const mfa = app.get(MfaService);
  const notificacoes = app.get(NotificacoesMandatoService);
  const rascunhos = app.get(RascunhosService);
  const expedicoes = app.get(ExpedicaoWorkerService);
  let nextCleanup = 0;
  let nextAlertas = 0;
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  async function processarArtefatos() {
    let proximaLimpeza = 0;
    while (!stopping) {
      try {
        if (Date.now() >= proximaLimpeza) {
          proximaLimpeza = Date.now() + 3600000;
          await rascunhos.limparTemporarios();
        }
        const renderizou = await rascunhos.executarUm();
        const expediu = await expedicoes.executarUm();
        if (!renderizou && !expediu) await aguardar(2000);
      } catch {
        process.stderr.write('Falha operacional no worker de artefatos da secretaria.\n');
        await aguardar(5000);
      }
    }
  }
  const artefatos = featureEnabled('secretaria') ? processarArtefatos() : undefined;
  while (!stopping) {
    try {
      if (Date.now() >= nextCleanup) {
        try { await mfa.clearExpiredPending(); nextCleanup = Date.now() + 60 * 60_000; }
        catch { process.stderr.write('Falha na limpeza de lotes MFA expirados.\n'); nextCleanup = Date.now() + 5 * 60_000; }
      }
      if (featureEnabled('governanca') && Date.now() >= nextAlertas) {
        try {
          const resultado = await notificacoes.gerar();
          if (resultado.falhas) { process.stderr.write('Falha na geração de alertas de oficiais.\n'); nextAlertas = Date.now() + 5 * 60_000; }
          else nextAlertas = Date.now() + 60 * 60_000;
        } catch { process.stderr.write('Falha na geração de alertas de oficiais.\n'); nextAlertas = Date.now() + 5 * 60_000; }
      }
      if (!await outbox.runOnce()) await aguardar(2000);
    } catch {
      // Sem dados sensíveis nem mensagens arbitrárias de SMTP nos logs.
      process.stderr.write('Falha operacional no worker de e-mail.\n');
      await aguardar(5000);
    }
  }
  await artefatos;
  await app.close();
}
bootstrap().catch(() => { process.stderr.write('Não foi possível iniciar o worker de e-mail.\n'); process.exitCode = 1; });
