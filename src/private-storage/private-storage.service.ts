import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { logs_atividades_acao, Prisma } from '@prisma/client';
import { randomUUID, createHash } from 'crypto';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { verificarSigiloDosAnexos } from '../secretaria/sigilo-anexos';
import { PrismaService } from 'src/prisma/prisma.service';

interface Actor { sub: string; igreja_id: string }
interface Arquivo { id: string; igreja_id: string; tamanho: number; sha256: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT = 10 * 1024 * 1024;
export const LIMITE_ARTEFATO_EXPEDICAO = 20 * 1024 * 1024;

export const arquivoSemVinculoDeExpedicao = {
  vias_coleta: { none: {} },
  finais_documento: { none: {} },
  faces_livro: { none: {} },
  scans_assinatura: { none: {} },
} satisfies Prisma.arquivo_privadoWhereInput;
@Injectable()
export class PrivateStorageService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  private async root(): Promise<string> {
    const configured = this.config.get<string>('PRIVATE_STORAGE_ROOT');
    if (process.env.NODE_ENV === 'production' && !configured) throw new InternalServerErrorException('Armazenamento privado não configurado.');
    const location = configured ?? path.join(process.cwd(), 'private-storage');
    if (!path.isAbsolute(location)) throw new InternalServerErrorException('Armazenamento privado não configurado.');
    await fs.mkdir(location, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(location);
    const publicPath = path.join(process.cwd(), 'uploads');
    const publicRoot = await fs.realpath(publicPath).catch(() => path.resolve(publicPath));
    const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
    if (inside(root, publicRoot) || inside(publicRoot, root)) throw new InternalServerErrorException('Armazenamento privado inválido.');
    const stat = await fs.stat(root);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new InternalServerErrorException('Permissões do armazenamento privado inválidas.');
    return root;
  }

  async save(actor: Actor, data: Buffer) {
    if (!Buffer.isBuffer(data) || !data.length || data.length > LIMIT) throw new BadRequestException('Arquivo inválido ou maior que 10 MB.');
    const id = randomUUID();
    const hash = createHash('sha256').update(data).digest('hex');
    const filename = path.join(await this.root(), id);
    let handle: fs.FileHandle | undefined;
    let created = false;
    let dbStarted = false;
    try {
      handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      await handle.writeFile(data);
      await handle.close();
      handle = undefined;
      dbStarted = true;
      await this.prisma.$transaction(async tx => {
        await tx.arquivo_privado.create({ data: { id, igreja_id: actor.igreja_id, usuario_id: actor.sub, sha256: hash, tamanho: data.length } });
        await tx.logs_atividades.create({ data: { igreja_id: actor.igreja_id, usuario_id: actor.sub, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'arquivo_privado', registro_id: id } });
      });
      return { id, tamanho: data.length };
    } catch (error) {
      await handle?.close().catch(() => {});
      // Após iniciar a transação, resultado de commit pode ser incerto: preservar bytes para reconciliação.
      if (created && !dbStarted) await fs.unlink(filename).catch(() => {});
      throw error;
    }
  }

  async read(actor: Actor, id: string): Promise<Buffer> {
    if (!uuid.test(id)) throw new NotFoundException('Arquivo não encontrado.');
    // A política inicial só permite ao responsável, na própria igreja. Nenhuma permissão é herdada do perfil técnico.
    const file = await this.prisma.$transaction(async tx => {
      const arquivo = await tx.arquivo_privado.findFirst({
        where: {
          id, igreja_id: actor.igreja_id, usuario_id: actor.sub, artefatos_documento: { none: {} },
          livros_historicos: { none: {} }, registros_livro: { none: {} }, ...arquivoSemVinculoDeExpedicao,
        },
      });
      if (!arquivo) throw new NotFoundException('Arquivo não encontrado.');
      await verificarSigiloDosAnexos(tx, actor.igreja_id, actor.sub, [id]);
      return arquivo;
    }, { isolationLevel: 'RepeatableRead' });
    return this.readAuthorized(actor, file);
  }

  /** Metadados obtidos pelo servidor após autorizar o documento/versão; nunca aceitar do cliente. */
  async readAuthorized(actor: Actor, file: Arquivo, tabelaAuditoria: 'arquivo_privado' | 'anexo_documento_consulta' = 'arquivo_privado'): Promise<Buffer> {
    if (file.igreja_id !== actor.igreja_id) throw new NotFoundException('Arquivo não encontrado.');
    const data = await this.readVerified(file);
    await this.prisma.logs_atividades.create({ data: { igreja_id: actor.igreja_id, usuario_id: actor.sub, acao: logs_atividades_acao.DOWNLOAD, tabela_afetada: tabelaAuditoria, registro_id: file.id } });
    return data;
  }

  /** Para processamento interno de referências já autorizadas e verificadas pelo servidor. */
  async readVerified(file: Arquivo): Promise<Buffer> {
    if (!uuid.test(file.id)) throw new NotFoundException('Arquivo não encontrado.');
    const filename = path.join(await this.root(), file.id);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.tamanho || stat.size > LIMITE_ARTEFATO_EXPEDICAO) throw new InternalServerErrorException('Integridade do arquivo inválida.');
      data = await handle.readFile();
    } finally { await handle.close(); }
    if (data.length !== file.tamanho || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new InternalServerErrorException('Integridade do arquivo inválida.');
    return data;
  }

  /** Chamado sob o bloqueio do trabalho, antes de vinculá-lo ao arquivo na mesma transação. */
  async saveArtifact(tx: Prisma.TransactionClient, actor: Actor, id: string, data: Buffer, limite = LIMIT) {
    if (!uuid.test(id) || !data.length || data.length > limite) throw new Error('Artefato inválido.');
    const root = await this.root();
    const staging = path.join(root, `.render-${randomUUID()}`);
    const file = await tx.arquivo_privado.create({
      data: { id, igreja_id: actor.igreja_id, usuario_id: actor.sub, tamanho: data.length, sha256: createHash('sha256').update(data).digest('hex') },
    });
    try {
      const handle = await fs.open(staging, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); }
      finally { await handle.close(); }
      // A mesma tarefa reaproveita este nome após uma interrupção anterior ao commit.
      await fs.rename(staging, path.join(root, id));
      const dir = await fs.open(root, 'r');
      try { await dir.sync(); }
      finally { await dir.close(); }
    } finally {
      await fs.unlink(staging).catch(() => {});
    }
    return file;
  }

  async clearRenderTemps() {
    const root = await this.root();
    const limite = Date.now() - 3600000;
    for (const entry of await fs.readdir(root)) {
      if (!entry.startsWith('.render-') || !uuid.test(entry.slice(8))) continue;
      const file = path.join(root, entry);
      const stat = await fs.lstat(file).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < limite) await fs.unlink(file).catch(() => {});
    }
  }
}
