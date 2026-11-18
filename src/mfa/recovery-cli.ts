import { readFile, stat } from 'fs/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { EmergencyRecoveryService } from './emergency-recovery.service';

async function main() {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3 || (await stat(file)).size > 16_384) throw new Error('Arquivo inválido.');
  const input: unknown = JSON.parse(await readFile(file, 'utf8'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try { await app.get(EmergencyRecoveryService).recover(input); process.stdout.write('Recuperação registrada. O usuário precisa configurar novo MFA.\n'); }
  finally { await app.close(); }
}
main().catch(() => { process.stderr.write('Recuperação recusada; confira autorização, chave pública, prazo e estado da conta.\n'); process.exitCode = 1; });
