# Design: Migração MySQL/AWS → PostgreSQL Local + Storage Local

**Data:** 2026-03-26
**Escopo:** Migração completa de infraestrutura — banco de dados e armazenamento de arquivos
**Status:** Aprovado

---

## Contexto

O projeto `provisao_api` (NestJS + Prisma) usa atualmente:
- **Banco de dados:** MySQL no AWS RDS (`sa-east-1`)
- **Arquivos:** AWS S3 (`provisao-app-arquivos`)

Objetivo: eliminar todas as dependências de AWS, rodando tudo localmente com PostgreSQL já instalado na máquina de desenvolvimento.

---

## Decisões de Design

| Aspecto | Antes | Depois |
|---|---|---|
| Banco de dados | MySQL (AWS RDS) | PostgreSQL local |
| Arquivos | AWS S3 | Filesystem local (`uploads/`) |
| Serving de arquivos | URL pública S3 | `ServeStaticModule` NestJS em `/uploads` |
| Dados existentes | — | Banco novo (zero) |

---

## 1. Banco de Dados

### Alterações no schema Prisma

**datasource:** trocar `provider = "mysql"` → `provider = "postgresql"`

**Anotações `@db.*`:** a maioria é cross-compatível. Alterações necessárias:
- `@db.Timestamp(0)` → remover a anotação `@db.Timestamp(0)` (Prisma usa `TIMESTAMP(3)` por padrão no PG, que é adequado)
- Todas as demais (`@db.VarChar`, `@db.Text`, `@db.Date`, `@db.Decimal`) são válidas em PostgreSQL

**Nomes de mapa em constraints:** os atributos `map: "nome_ibfk_1"` (estilo MySQL) são mantidos — Prisma os usa como nomes de constraint em PG sem problema.

### Banco local

- Criar banco `provisao_db` no cluster local (PostgreSQL com usuário `postgres`)
- `DATABASE_URL`: `postgresql://postgres:DevTempP4$$@localhost:5432/provisao_db`
- Rodar `prisma migrate dev --name init` para gerar e aplicar a migration inicial

---

## 2. Armazenamento de Arquivos

### StorageModule (substitui S3Module)

**Localização:** `src/storage/` (renomear de `src/s3/`)

**Interface pública idêntica ao S3Service:**
```typescript
uploadFile(file: Express.Multer.File, folder: string): Promise<string>
```

**Implementação:**
- Diretório base: `<project_root>/uploads/`
- Nome do arquivo: `uuid() + extensão extraída do mimetype ou originalname`
- Antes de escrever: `fs/promises.mkdir(dir, { recursive: true })` para garantir que o subdiretório existe
- Escreve o buffer em disco com `fs/promises.writeFile`
- Retorna path relativo: `/uploads/{folder}/{filename}`

**Exportação:** `StorageModule` deve ter `exports: [StorageService]` para que outros módulos possam injetar o serviço via import do módulo.

**Serving de arquivos estáticos:**
- `ServeStaticModule.forRoot({ rootPath: join(__dirname, '..', 'uploads'), serveRoot: '/uploads' })`
- Instalar `@nestjs/serve-static`

### Variáveis de ambiente removidas
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_S3_BUCKET_NAME
AWS_REGION
```

### Pacotes npm removidos
```
@aws-sdk/client-s3
@aws-sdk/lib-storage
```

---

## 3. Arquivos a Criar/Modificar

| Arquivo | Ação |
|---|---|
| `prisma/schema.prisma` | Trocar provider, remover `@db.Timestamp(0)` |
| `.env` | Atualizar `DATABASE_URL`, remover vars AWS |
| `src/storage/storage.service.ts` | Criar (substitui s3.service.ts) |
| `src/storage/storage.module.ts` | Criar (substitui s3.module.ts) |
| `src/s3/s3.service.ts` | Remover |
| `src/s3/s3.module.ts` | Remover |
| `src/pessoas/pessoas.module.ts` | Trocar S3Module → StorageModule |
| `src/pessoas/pessoas.controller.ts` | Trocar S3Service → StorageService |
| `src/usuarios/usuarios.module.ts` | Trocar S3Module → StorageModule |
| `src/usuarios/usuarios.controller.ts` | Trocar S3Service → StorageService |
| `src/app.module.ts` | Remover S3Module e S3Service do array `providers`, adicionar ServeStaticModule |
| `package.json` | Remover @aws-sdk/*, adicionar @nestjs/serve-static |

---

## 4. Criação do Banco PostgreSQL

```sql
CREATE DATABASE provisao_db;
```

Executado via `psql -U postgres` com senha `DevTempP4$$`.

---

## 5. Segurança — Credenciais AWS

As credenciais AWS presentes no `.env` atual (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) e a `DATABASE_URL` do RDS devem ser **revogadas/rotacionadas no console AWS** após a migração, pois estarão obsoletas. Verificar também que `.env` está no `.gitignore`.

---

## 6. Critérios de Sucesso

- `npm run build` sem erros (sem imports de @aws-sdk ou S3Service)
- `prisma migrate dev` aplica migration sem erros
- Upload de foto via `PATCH /pessoas/atrib-foto-pessoa/:id` salva arquivo em `uploads/fotos-pessoas/`
- Arquivo servido corretamente em `GET /uploads/fotos-pessoas/{filename}`
- `npm audit` retorna 0 vulnerabilidades
- Nenhuma referência a AWS no código-fonte
