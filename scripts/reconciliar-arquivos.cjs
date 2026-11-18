#!/usr/bin/env node
// Diagnóstico somente de leitura. Execute com escritas suspensas para evitar resultados inconsistentes.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

async function fileHash(file) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return null;
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    return { size: stat.size, hash: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('A rotina não aceita argumentos.');
  const configured = process.env.PRIVATE_STORAGE_ROOT;
  if (!configured || !path.isAbsolute(configured)) throw new Error('Configure PRIVATE_STORAGE_ROOT com caminho absoluto.');
  const root = await fs.promises.realpath(configured);
  const rootStat = await fs.promises.stat(root);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) throw new Error('Permissões da raiz privada inválidas.');
  const publicPath = path.join(process.cwd(), 'uploads');
  const publicRoot = await fs.promises.realpath(publicPath).catch(() => path.resolve(publicPath));
  const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  if (within(root, publicRoot) || within(publicRoot, root)) throw new Error('Raiz privada sobrepõe uploads públicos.');
  const prisma = new PrismaClient();
  try {
    const entries = await fs.promises.readdir(root);
    const candidates = new Set(entries);
    const totals = { metadados: 0, verificados: 0, ausentes: 0, divergentes: 0, inacessiveis: 0, sem_metadados: 0 };
    let after;
    for (;;) {
      const records = await prisma.arquivo_privado.findMany({ take: 200, ...(after ? { skip: 1, cursor: { id: after } } : {}), orderBy: { id: 'asc' }, select: { id: true, tamanho: true, sha256: true } });
      if (!records.length) break;
      for (const record of records) {
        totals.metadados++;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id)) { totals.divergentes++; continue; }
        candidates.delete(record.id);
        try {
          const observed = await fileHash(path.join(root, record.id));
          if (observed && observed.size === record.tamanho && observed.hash === record.sha256) totals.verificados++;
          else totals.divergentes++;
        } catch (error) {
          if (error.code === 'ENOENT') totals.ausentes++;
          else totals.inacessiveis++;
        }
      }
      after = records[records.length - 1].id;
    }
    totals.sem_metadados = candidates.size;
    process.stdout.write(JSON.stringify(totals) + '\n');
    if (totals.ausentes || totals.divergentes || totals.inacessiveis || totals.sem_metadados) process.exitCode = 2;
  } finally { await prisma.$disconnect(); }
}
main().catch(() => { process.stderr.write('Não foi possível conferir o armazenamento privado.\n'); process.exitCode = 1; });
