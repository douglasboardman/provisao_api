# Migração MySQL/AWS → PostgreSQL Local + Storage Local

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir MySQL (AWS RDS) e AWS S3 por PostgreSQL local e armazenamento em filesystem, eliminando todas as dependências de AWS.

**Architecture:** Prisma troca de provider `mysql` → `postgresql`; novo `StorageModule` substitui `S3Module` salvando arquivos em `uploads/` no disco e servindo via `ServeStaticModule`; todos os módulos/controllers que injetavam `S3Service` passam a injetar `StorageService`.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL (local), `@nestjs/serve-static`, `fs/promises` (Node built-in)

**Spec:** `docs/superpowers/specs/2026-03-26-postgres-migration-design.md`

---

## Mapa de Arquivos

| Arquivo | Ação |
|---|---|
| `prisma/schema.prisma` | Modificar — trocar provider, remover `@db.Timestamp(0)` |
| `.env` | Modificar — nova DATABASE_URL, remover vars AWS |
| `src/storage/storage.service.ts` | Criar |
| `src/storage/storage.module.ts` | Criar |
| `src/s3/s3.service.ts` | Remover |
| `src/s3/s3.module.ts` | Remover |
| `src/app.module.ts` | Modificar — trocar S3→Storage, adicionar ServeStaticModule |
| `src/pessoas/pessoas.module.ts` | Modificar — trocar S3Module→StorageModule |
| `src/pessoas/pessoas.controller.ts` | Modificar — trocar S3Service→StorageService |
| `src/usuarios/usuarios.module.ts` | Modificar — trocar S3Module→StorageModule |
| `src/usuarios/usuarios.controller.ts` | Modificar — trocar S3Service→StorageService |
| `package.json` | Modificar — remover @aws-sdk/*, adicionar @nestjs/serve-static |

---

## Task 1: Criar banco PostgreSQL local

**Files:**
- Modify: `.env`

- [ ] **Step 1: Criar o banco de dados**

```bash
PGPASSWORD='DevTempP4$$' psql -U postgres -c "CREATE DATABASE provisao_db;"
```

Esperado: `CREATE DATABASE`

- [ ] **Step 2: Verificar conexão**

```bash
PGPASSWORD='DevTempP4$$' psql -U postgres -d provisao_db -c "\conninfo"
```

Esperado: `You are connected to database "provisao_db"`

- [ ] **Step 3: Atualizar DATABASE_URL no .env**

Substituir a linha `DATABASE_URL=mysql://...` por:
```
DATABASE_URL=postgresql://postgres:DevTempP4$$@localhost:5432/provisao_db
```

Remover as seguintes linhas do `.env`:
```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET_NAME=...
AWS_REGION=...
```

- [ ] **Step 4: Commit**

```bash
git add .env
git commit -m "chore: atualiza .env para PostgreSQL local, remove vars AWS"
```

---

## Task 2: Migrar schema Prisma para PostgreSQL

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Trocar provider no datasource**

Em `prisma/schema.prisma`, alterar:
```prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
```
para:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- [ ] **Step 2: Remover todas as anotações `@db.Timestamp(0)`**

Localizar todas as ocorrências de `@db.Timestamp(0)` no schema (aparecem em `created_at` de todos os models) e removê-las. Exemplo — de:
```prisma
created_at DateTime @default(now()) @db.Timestamp(0)
```
para:
```prisma
created_at DateTime @default(now())
```

Isso se aplica a todos os models: `contas`, `descritivos_despesa`, `descritivos_receita`, `destinacoes`, `grupos_familiares`, `lancamentos`, `logs_atividades`, `pessoas`, `tipos_despesa`, `tipos_receita`, `usuarios`, `vinculos_membresia`.

- [ ] **Step 3: Validar schema**

```bash
npx prisma validate
```

Esperado: `The schema at prisma/schema.prisma is valid`

- [ ] **Step 4: Gerar e aplicar migration inicial**

```bash
npx prisma migrate dev --name init
```

Esperado: `Your database is now in sync with your schema.` (sem erros)

- [ ] **Step 5: Verificar tabelas criadas**

```bash
PGPASSWORD='DevTempP4$$' psql -U postgres -d provisao_db -c "\dt"
```

Esperado: lista com ~12 tabelas (contas, pessoas, usuarios, etc.)

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: migra schema Prisma de MySQL para PostgreSQL"
```

---

## Task 3: Instalar @nestjs/serve-static e remover @aws-sdk

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Instalar serve-static**

```bash
npm install @nestjs/serve-static
```

- [ ] **Step 2: Remover pacotes AWS**

```bash
npm uninstall @aws-sdk/client-s3 @aws-sdk/lib-storage
```

- [ ] **Step 3: Verificar 0 vulnerabilidades**

```bash
npm audit
```

Esperado: `found 0 vulnerabilities`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove @aws-sdk, adiciona @nestjs/serve-static"
```

---

## Task 4: Criar StorageModule e StorageService

**Files:**
- Create: `src/storage/storage.service.ts`
- Create: `src/storage/storage.module.ts`

- [ ] **Step 1: Escrever teste para StorageService**

Criar `src/storage/storage.service.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import * as fs from 'fs/promises';
import * as path from 'path';

jest.mock('fs/promises');

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StorageService],
    }).compile();
    service = module.get<StorageService>(StorageService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('uploadFile deve retornar path /uploads/{folder}/{uuid}.{ext}', async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    const mockFile = {
      buffer: Buffer.from('test'),
      originalname: 'foto.jpg',
      mimetype: 'image/jpeg',
    } as Express.Multer.File;

    const result = await service.uploadFile(mockFile, 'fotos-pessoas');

    expect(result).toMatch(/^\/uploads\/fotos-pessoas\/.+\.jpg$/);
    expect(fs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('fotos-pessoas'),
      { recursive: true },
    );
    expect(fs.writeFile).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar teste e confirmar falha**

```bash
npx jest storage.service.spec --no-coverage
```

Esperado: FAIL — `Cannot find module './storage.service'`

- [ ] **Step 3: Criar StorageService**

Criar `src/storage/storage.service.ts`:

```typescript
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuid } from 'uuid';

@Injectable()
export class StorageService {
  private readonly uploadsRoot = path.join(process.cwd(), 'uploads');

  async uploadFile(file: Express.Multer.File, folder: string): Promise<string> {
    const ext = path.extname(file.originalname) || this.extFromMime(file.mimetype);
    const filename = `${uuid()}${ext}`;
    const dir = path.join(this.uploadsRoot, folder);
    const filepath = path.join(dir, filename);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filepath, file.buffer);
      return `/uploads/${folder}/${filename}`;
    } catch (error) {
      console.error('Erro ao salvar arquivo local:', error);
      throw new InternalServerErrorException('Ocorreu um erro ao tentar salvar o arquivo.');
    }
  }

  private extFromMime(mimetype: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'application/pdf': '.pdf',
    };
    return map[mimetype] ?? '';
  }
}
```

- [ ] **Step 4: Criar StorageModule**

Criar `src/storage/storage.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
```

- [ ] **Step 5: Rodar testes e confirmar passagem**

```bash
npx jest storage.service.spec --no-coverage
```

Esperado: PASS (3 testes)

- [ ] **Step 6: Commit**

```bash
git add src/storage/
git commit -m "feat: cria StorageService local substituindo S3Service"
```

---

## Task 5: Atualizar AppModule

**Files:**
- Modify: `src/app.module.ts`

- [ ] **Step 1: Atualizar app.module.ts**

Substituir o conteúdo por:

```typescript
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { PessoasModule } from './pessoas/pessoas.module';
import { ConfigModule } from '@nestjs/config';
import { GruposFamiliaresModule } from './grupos-familiares/grupos-familiares.module';
import { TiposDespesaModule } from './tipos-despesa/tipos-despesa.module';
import { TiposReceitaModule } from './tipos-receita/tipos-receita.module';
import { ContasModule } from './contas/contas.module';
import { DescritivosReceitaModule } from './descritivos-receita/descritivos-receita.module';
import { DescritivosDespesaModule } from './descritivos-despesa/descritivos-despesa.module';
import { VinculosMembresiaModule } from './vinculos-membresia/vinculos-membresia.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    PrismaModule,
    AuthModule,
    UsuariosModule,
    PessoasModule,
    GruposFamiliaresModule,
    TiposDespesaModule,
    TiposReceitaModule,
    ContasModule,
    DescritivosReceitaModule,
    DescritivosDespesaModule,
    VinculosMembresiaModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
```

> Nota: `S3Module` e `S3Service` foram removidos dos `imports` e `providers`. `process.cwd()` é preferível a `__dirname` para o `rootPath` do ServeStaticModule, pois resolve corretamente tanto em dev (ts-node) quanto em prod (dist/).

- [ ] **Step 2: Commit**

```bash
git add src/app.module.ts
git commit -m "feat: atualiza AppModule — remove S3, adiciona ServeStaticModule"
```

---

## Task 6: Atualizar PessoasModule e PessoasController

**Files:**
- Modify: `src/pessoas/pessoas.module.ts`
- Modify: `src/pessoas/pessoas.controller.ts`

- [ ] **Step 1: Atualizar pessoas.module.ts (edição cirúrgica — NÃO substituir o arquivo inteiro)**

Fazer dois replace pontuais para preservar o import `GruposFamiliare` existente na linha 5:

Substituir apenas o import do S3Module:
```typescript
// Remover:
import { S3Module } from 'src/s3/s3.module';
// Adicionar:
import { StorageModule } from 'src/storage/storage.module';
```

Substituir apenas o decorator imports:
```typescript
// Remover:
  imports: [S3Module],
// Adicionar:
  imports: [StorageModule],
```

- [ ] **Step 2: Atualizar pessoas.controller.ts**

Alterar o import de S3Service:
```typescript
// Remover:
import { S3Service } from 'src/s3/s3.service';
// Adicionar:
import { StorageService } from 'src/storage/storage.service';
```

Alterar o constructor e uso:
```typescript
constructor(
  private readonly pessoasService: PessoasService,
  private readonly storageService: StorageService   // era s3Service
) { }
```

No método `uploadFotoPessoa`, alterar:
```typescript
// Remover:
const fotoUrl = await this.s3Service.uploadFile(file, 'fotos-pessoas');
// Adicionar:
const fotoUrl = await this.storageService.uploadFile(file, 'fotos-pessoas');
```

- [ ] **Step 3: Commit**

```bash
git add src/pessoas/
git commit -m "feat: pessoas — migra S3Service para StorageService"
```

---

## Task 7: Atualizar UsuariosModule e UsuariosController

**Files:**
- Modify: `src/usuarios/usuarios.module.ts`
- Modify: `src/usuarios/usuarios.controller.ts`

- [ ] **Step 1: Atualizar usuarios.module.ts**

```typescript
import { Module } from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { UsuariosController } from './usuarios.controller';
import { StorageModule } from 'src/storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [UsuariosController],
  providers: [UsuariosService],
})
export class UsuariosModule {}
```

- [ ] **Step 2: Atualizar usuarios.controller.ts**

Alterar o import de S3Service:
```typescript
// Remover:
import { S3Service } from 'src/s3/s3.service';
// Adicionar:
import { StorageService } from 'src/storage/storage.service';
```

Alterar o constructor:
```typescript
constructor(
  private readonly usuariosService: UsuariosService,
  private readonly storageService: StorageService   // era s3Service
) { }
```

No método `uploadProfileImage`, alterar:
```typescript
// Remover:
const imageUrl = await this.s3Service.uploadFile(file, 'user-profiles');
// Adicionar:
const imageUrl = await this.storageService.uploadFile(file, 'user-profiles');
```

- [ ] **Step 3: Commit**

```bash
git add src/usuarios/
git commit -m "feat: usuarios — migra S3Service para StorageService"
```

---

## Task 8: Remover S3Module e S3Service

**Files:**
- Delete: `src/s3/s3.service.ts`
- Delete: `src/s3/s3.module.ts`

- [ ] **Step 1: Confirmar que nenhum arquivo ainda importa S3**

```bash
grep -r "s3" src/ --include="*.ts" -l
```

Esperado: nenhuma saída (ou apenas os próprios arquivos s3/ que vamos deletar)

- [ ] **Step 2: Deletar arquivos S3**

```bash
rm src/s3/s3.service.ts src/s3/s3.module.ts
rmdir src/s3/
```

- [ ] **Step 3: Commit**

```bash
git add -A src/s3/
git commit -m "chore: remove S3Module e S3Service (substituídos por StorageModule)"
```

---

## Task 9: Build final e verificação

- [ ] **Step 1: Rodar todos os testes**

```bash
npx jest --no-coverage
```

Esperado: todos os testes passando (sem erros de import)

- [ ] **Step 2: Build TypeScript**

```bash
npm run build
```

Esperado: sem erros de compilação

- [ ] **Step 3: Confirmar 0 referências AWS no código**

```bash
grep -r "aws\|s3Service\|S3Service\|S3Module" src/ --include="*.ts" -i
```

Esperado: nenhuma saída

- [ ] **Step 4: Verificar vulnerabilidades**

```bash
npm audit
```

Esperado: `found 0 vulnerabilities`

- [ ] **Step 5: Smoke test da aplicação**

```bash
npm run start:dev
```

Verificar nos logs: sem erros de `S3`, sem `InternalServerException` ao iniciar. A aplicação deve subir na porta 3000.

- [ ] **Step 6: Commit final**

```bash
git add -A
git commit -m "chore: verificação final — migração MySQL/AWS → PostgreSQL/local completa"
```
