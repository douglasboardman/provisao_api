#!/usr/bin/env node
// Executar no ambiente isolado do custodiante, com Node.js e a chave privada local.
const { readFileSync, writeFileSync } = require('node:fs');
const { createPrivateKey, sign } = require('node:crypto');
try {
  if (process.argv.length !== 5) throw new Error('Uso: node assinar-recuperacao.cjs chave-privada.pem pedido.json autorizado.json');
  const [, , keyPath, requestPath, outputPath] = process.argv;
  const a = JSON.parse(readFileSync(requestPath, 'utf8'));
  const expected = ['versao', 'igreja_id', 'usuario_id', 'emitido_em', 'expira_em', 'nonce', 'autoridade', 'motivo'];
  if (!a || typeof a !== 'object' || Object.keys(a).length !== expected.length || expected.some(k => !(k in a))) throw new Error('Campos do pedido inválidos.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const clean = (value, min, max) => typeof value === 'string' && value === value.trim() && value.length >= min && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  const now = Math.floor(Date.now() / 1000);
  if (a.versao !== 1 || !uuid.test(a.igreja_id) || !uuid.test(a.usuario_id) || !Number.isSafeInteger(a.emitido_em) || !Number.isSafeInteger(a.expira_em) || a.emitido_em > now + 60 || a.emitido_em < now - 600 || a.expira_em <= now || a.expira_em <= a.emitido_em || a.expira_em - a.emitido_em > 600 || !/^[a-f0-9]{64}$/.test(a.nonce) || !clean(a.autoridade, 3, 120) || !clean(a.motivo, 20, 500)) throw new Error('Conteúdo ou prazo do pedido inválido.');
  const key = createPrivateKey(readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('A chave precisa ser Ed25519.');
  const message = Buffer.from(JSON.stringify(['provisao-mfa-recovery-v1', a.versao, a.igreja_id, a.usuario_id, a.emitido_em, a.expira_em, a.nonce, a.autoridade, a.motivo]), 'utf8');
  writeFileSync(outputPath, JSON.stringify({ ...a, assinatura: sign(null, message, key).toString('base64url') }) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write('Autorização assinada criada.\n');
} catch (e) { process.stderr.write(`Falha ao assinar: ${e.message}\n`); process.exitCode = 1; }
