# Módulo Igreja — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `igreja` NestJS module — the multi-tenant anchor — with superadmin creation via API key and JWT-protected read/update endpoints for the authenticated church.

**Architecture:** `AdminKeyGuard` validates `X-Admin-Key` header against `ADMIN_KEY` env var for the creation endpoint; all other endpoints use existing `AuthGuard` + `RolesGuard`. `IgrejaService` enforces global CNPJ uniqueness and validates `vinculada_a` FK. `StorageService` handles logo upload to `uploads/church-logos/`.

**Tech Stack:** NestJS 11, Prisma, nestjs-zod, ConfigService (global), StorageService (imported via StorageModule), AuthModule (for AuthGuard/RolesGuard DI).

## Global Constraints

- All commands run from repo root: `/home/douglasboardman/github/provisao`
- NestJS module files use `src/` path aliases (mapped in jest `moduleNameMapper`)
- DTOs: `createZodDto` from `nestjs-zod`, schema exported separately for reuse in UpdateDto
- Guards: `@UseGuards(AuthGuard, RolesGuard)` — order matters (auth first, then roles)
- `ALL_ROLES` exported from `src/auth/guards/roles/roles.guard.ts`
- `AdminKeyGuard` must be **fail-closed**: deny if `ADMIN_KEY` env var is undefined
- Run tests: `cd provisao_api && npx jest src/igreja --verbose`
- Run build: `cd provisao_api && npm run build`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/igreja/guards/admin-key.guard.ts` | Validates `X-Admin-Key` header |
| Create | `src/igreja/guards/admin-key.guard.spec.ts` | Unit tests for AdminKeyGuard |
| Create | `src/igreja/dto/create-igreja.dto.ts` | Zod schema + DTO for creation |
| Create | `src/igreja/dto/update-igreja.dto.ts` | Partial schema omitting `congregacao`/`vinculada_a` |
| Create | `src/igreja/igreja.service.ts` | Business logic: create, findMe, updateMe, updateLogo, findCongregacoes |
| Create | `src/igreja/igreja.service.spec.ts` | Unit tests for IgrejaService |
| Create | `src/igreja/igreja.controller.ts` | 5 endpoints with correct guards |
| Create | `src/igreja/igreja.module.ts` | Module declaration |
| Modify | `src/app.module.ts` | Register IgrejaModule |

---

### Task 1: AdminKeyGuard + DTOs

**Files:**
- Create: `provisao_api/src/igreja/guards/admin-key.guard.ts`
- Create: `provisao_api/src/igreja/guards/admin-key.guard.spec.ts`
- Create: `provisao_api/src/igreja/dto/create-igreja.dto.ts`
- Create: `provisao_api/src/igreja/dto/update-igreja.dto.ts`

**Interfaces:**
- Produces: `AdminKeyGuard` (injectable guard), `CreateIgrejaDto`, `UpdateIgrejaDto`, `CreateIgrejaSchema` (for UpdateDto reuse)

- [ ] **Step 1: Create `admin-key.guard.ts`**

```typescript
// provisao_api/src/igreja/guards/admin-key.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = req.headers['x-admin-key'];
    const expected = this.configService.get<string>('ADMIN_KEY');

    if (!expected || key !== expected) {
      throw new ForbiddenException('Acesso negado.');
    }

    return true;
  }
}
```

- [ ] **Step 2: Write failing tests for AdminKeyGuard**

```typescript
// provisao_api/src/igreja/guards/admin-key.guard.spec.ts
import { AdminKeyGuard } from './admin-key.guard';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

describe('AdminKeyGuard', () => {
  let guard: AdminKeyGuard;
  let configService: { get: jest.Mock };

  beforeEach(() => {
    configService = { get: jest.fn().mockReturnValue('secret-key') };
    guard = new AdminKeyGuard(configService as unknown as ConfigService);
  });

  function makeContext(key?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: key ? { 'x-admin-key': key } : {} }),
      }),
    } as unknown as ExecutionContext;
  }

  it('permite quando a chave está correta', () => {
    expect(guard.canActivate(makeContext('secret-key'))).toBe(true);
  });

  it('lança ForbiddenException quando a chave está errada', () => {
    expect(() => guard.canActivate(makeContext('wrong-key'))).toThrow(ForbiddenException);
  });

  it('lança ForbiddenException quando nenhuma chave é enviada', () => {
    expect(() => guard.canActivate(makeContext())).toThrow(ForbiddenException);
  });

  it('lança ForbiddenException quando ADMIN_KEY não está configurada (fail-closed)', () => {
    configService.get.mockReturnValue(undefined);
    expect(() => guard.canActivate(makeContext('any-key'))).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 3: Run tests (expect PASS — guard is already written)**

```bash
cd provisao_api && npx jest src/igreja/guards --verbose
```

Expected: 4 passing tests.

- [ ] **Step 4: Create `create-igreja.dto.ts`**

```typescript
// provisao_api/src/igreja/dto/create-igreja.dto.ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { estados_brasil } from '@prisma/client';

export const CreateIgrejaSchema = z.object({
  nome: z.string().min(1, 'O nome da igreja não pode estar vazio.'),
  cnpj: z
    .string()
    .length(14, 'O CNPJ deve conter exatamente 14 dígitos.')
    .regex(/^\d{14}$/, 'O CNPJ deve conter apenas dígitos numéricos.')
    .optional(),
  congregacao: z.boolean().default(false),
  vinculada_a: z.string().uuid('O campo vinculada_a deve ser um UUID válido.').optional(),
  cep: z
    .string()
    .length(8, 'O CEP deve conter exatamente 8 dígitos.')
    .regex(/^\d{8}$/, 'O CEP deve conter apenas dígitos numéricos.')
    .optional(),
  logradouro: z.string().optional(),
  numero: z.string().optional(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
  cidade: z.string().optional(),
  estado: z.nativeEnum(estados_brasil, { error: 'O estado informado é inválido.' }).optional(),
});

export class CreateIgrejaDto extends createZodDto(CreateIgrejaSchema) {}
```

- [ ] **Step 5: Create `update-igreja.dto.ts`**

```typescript
// provisao_api/src/igreja/dto/update-igreja.dto.ts
import { createZodDto } from 'nestjs-zod';
import { CreateIgrejaSchema } from './create-igreja.dto';

export class UpdateIgrejaDto extends createZodDto(
  CreateIgrejaSchema.omit({ congregacao: true, vinculada_a: true }).partial(),
) {}
```

- [ ] **Step 6: Commit Task 1**

```bash
cd /home/douglasboardman/github/provisao
git add provisao_api/src/igreja/guards/ provisao_api/src/igreja/dto/
git commit -m "feat(igreja): add AdminKeyGuard and DTOs"
```

---

### Task 2: IgrejaService

**Files:**
- Create: `provisao_api/src/igreja/igreja.service.ts`
- Create: `provisao_api/src/igreja/igreja.service.spec.ts`

**Interfaces:**
- Consumes: `CreateIgrejaDto`, `UpdateIgrejaDto` (Task 1), `PrismaService`, `StorageService`
- Produces: `IgrejaService` with methods: `create`, `findMe`, `updateMe`, `updateLogo`, `findCongregacoes`

- [ ] **Step 1: Write failing tests for IgrejaService**

```typescript
// provisao_api/src/igreja/igreja.service.spec.ts
import { Test } from '@nestjs/testing';
import { IgrejaService } from './igreja.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { StorageService } from 'src/storage/storage.service';
import { ConflictException, NotFoundException } from '@nestjs/common';

const mockIgreja = {
  id: 'church-1',
  nome: 'Igreja Teste',
  cnpj: null,
  congregacao: false,
  vinculada_a: null,
  url_logo: null,
  cep: null,
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cidade: null,
  estado: null,
  ativa: true,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('IgrejaService', () => {
  let service: IgrejaService;
  let prisma: {
    igreja: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let storage: { uploadFile: jest.Mock };

  beforeEach(async () => {
    prisma = {
      igreja: {
        findUnique: jest.fn().mockResolvedValue(mockIgreja),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(mockIgreja),
        update: jest.fn().mockResolvedValue(mockIgreja),
      },
    };
    storage = { uploadFile: jest.fn().mockResolvedValue('/uploads/church-logos/abc.jpg') };

    const module = await Test.createTestingModule({
      providers: [
        IgrejaService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(IgrejaService);
  });

  // ── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('cria uma igreja sem CNPJ nem vinculada_a', async () => {
      prisma.igreja.create.mockResolvedValue({ ...mockIgreja, nome: 'Nova Igreja' });
      const result = await service.create({ nome: 'Nova Igreja', congregacao: false });
      expect(prisma.igreja.create).toHaveBeenCalled();
      expect(result.nome).toBe('Nova Igreja');
    });

    it('lança ConflictException se CNPJ já cadastrado', async () => {
      // findUnique for CNPJ check → returns existing church
      prisma.igreja.findUnique.mockResolvedValue({ ...mockIgreja, cnpj: '12345678000100' });
      await expect(
        service.create({ nome: 'X', congregacao: false, cnpj: '12345678000100' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.igreja.create).not.toHaveBeenCalled();
    });

    it('lança NotFoundException se vinculada_a não existe', async () => {
      // No CNPJ → skip CNPJ check. findUnique for vinculada_a → null
      prisma.igreja.findUnique.mockResolvedValue(null);
      await expect(
        service.create({ nome: 'Congregação', congregacao: true, vinculada_a: 'missing-id' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.igreja.create).not.toHaveBeenCalled();
    });
  });

  // ── findMe ────────────────────────────────────────────────────────────────

  describe('findMe', () => {
    it('retorna a igreja', async () => {
      const result = await service.findMe('church-1');
      expect(result.id).toBe('church-1');
    });

    it('lança NotFoundException se não encontrada', async () => {
      prisma.igreja.findUnique.mockResolvedValue(null);
      await expect(service.findMe('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateMe ──────────────────────────────────────────────────────────────

  describe('updateMe', () => {
    it('atualiza a igreja', async () => {
      const updated = { ...mockIgreja, nome: 'Novo Nome' };
      prisma.igreja.update.mockResolvedValue(updated);
      const result = await service.updateMe('church-1', { nome: 'Novo Nome' });
      expect(prisma.igreja.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'church-1' } }),
      );
      expect(result.nome).toBe('Novo Nome');
    });

    it('lança ConflictException se CNPJ já usado por outra igreja', async () => {
      prisma.igreja.findUnique
        .mockResolvedValueOnce(mockIgreja)                      // findMe → exists
        .mockResolvedValueOnce({ id: 'other-church' });         // CNPJ check → conflict
      await expect(
        service.updateMe('church-1', { cnpj: '12345678000100' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.igreja.update).not.toHaveBeenCalled();
    });

    it('não lança ConflictException se CNPJ pertence à própria igreja', async () => {
      prisma.igreja.findUnique
        .mockResolvedValueOnce(mockIgreja)                      // findMe
        .mockResolvedValueOnce({ ...mockIgreja, cnpj: '12345678000100' }); // CNPJ → same id
      await expect(
        service.updateMe('church-1', { cnpj: '12345678000100' }),
      ).resolves.not.toThrow();
    });
  });

  // ── updateLogo ────────────────────────────────────────────────────────────

  describe('updateLogo', () => {
    it('chama StorageService e atualiza url_logo', async () => {
      const file = { originalname: 'logo.jpg' } as Express.Multer.File;
      const updated = { ...mockIgreja, url_logo: '/uploads/church-logos/abc.jpg' };
      prisma.igreja.update.mockResolvedValue(updated);

      const result = await service.updateLogo('church-1', file);

      expect(storage.uploadFile).toHaveBeenCalledWith(file, 'church-logos');
      expect(prisma.igreja.update).toHaveBeenCalledWith({
        where: { id: 'church-1' },
        data: { url_logo: '/uploads/church-logos/abc.jpg' },
      });
      expect(result.url_logo).toBe('/uploads/church-logos/abc.jpg');
    });
  });

  // ── findCongregacoes ──────────────────────────────────────────────────────

  describe('findCongregacoes', () => {
    it('retorna lista de congregações vinculadas', async () => {
      const congregacao = { ...mockIgreja, id: 'cong-1', vinculada_a: 'church-1' };
      prisma.igreja.findMany.mockResolvedValue([congregacao]);
      const result = await service.findCongregacoes('church-1');
      expect(prisma.igreja.findMany).toHaveBeenCalledWith({
        where: { vinculada_a: 'church-1' },
      });
      expect(result).toHaveLength(1);
    });

    it('retorna lista vazia quando não há congregações', async () => {
      const result = await service.findCongregacoes('church-1');
      expect(result).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (IgrejaService not yet created)**

```bash
cd provisao_api && npx jest src/igreja/igreja.service --verbose
```

Expected: FAIL with "Cannot find module './igreja.service'"

- [ ] **Step 3: Create `igreja.service.ts`**

```typescript
// provisao_api/src/igreja/igreja.service.ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { StorageService } from 'src/storage/storage.service';
import { CreateIgrejaDto } from './dto/create-igreja.dto';
import { UpdateIgrejaDto } from './dto/update-igreja.dto';
import { igreja } from '@prisma/client';

@Injectable()
export class IgrejaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  async create(dto: CreateIgrejaDto): Promise<igreja> {
    if (dto.cnpj) {
      const existing = await this.prisma.igreja.findUnique({ where: { cnpj: dto.cnpj } });
      if (existing) throw new ConflictException('Este CNPJ já está cadastrado.');
    }

    if (dto.vinculada_a) {
      const matriz = await this.prisma.igreja.findUnique({ where: { id: dto.vinculada_a } });
      if (!matriz) throw new NotFoundException('Igreja matriz não encontrada.');
    }

    return this.prisma.igreja.create({ data: dto });
  }

  async findMe(igreja_id: string): Promise<igreja> {
    const record = await this.prisma.igreja.findUnique({ where: { id: igreja_id } });
    if (!record) throw new NotFoundException('Igreja não encontrada.');
    return record;
  }

  async updateMe(igreja_id: string, dto: UpdateIgrejaDto): Promise<igreja> {
    await this.findMe(igreja_id);

    if (dto.cnpj) {
      const existing = await this.prisma.igreja.findUnique({ where: { cnpj: dto.cnpj } });
      if (existing && existing.id !== igreja_id) {
        throw new ConflictException('Este CNPJ já está cadastrado.');
      }
    }

    return this.prisma.igreja.update({ where: { id: igreja_id }, data: dto });
  }

  async updateLogo(igreja_id: string, file: Express.Multer.File): Promise<igreja> {
    await this.findMe(igreja_id);
    const url_logo = await this.storageService.uploadFile(file, 'church-logos');
    return this.prisma.igreja.update({ where: { id: igreja_id }, data: { url_logo } });
  }

  async findCongregacoes(igreja_id: string): Promise<igreja[]> {
    return this.prisma.igreja.findMany({ where: { vinculada_a: igreja_id } });
  }
}
```

- [ ] **Step 4: Run tests — expect all PASS**

```bash
cd provisao_api && npx jest src/igreja --verbose
```

Expected: all tests pass (4 guard + ~9 service = 13 tests).

- [ ] **Step 5: Commit Task 2**

```bash
cd /home/douglasboardman/github/provisao
git add provisao_api/src/igreja/igreja.service.ts provisao_api/src/igreja/igreja.service.spec.ts
git commit -m "feat(igreja): add IgrejaService with unit tests"
```

---

### Task 3: IgrejaController + IgrejaModule + AppModule

**Files:**
- Create: `provisao_api/src/igreja/igreja.controller.ts`
- Create: `provisao_api/src/igreja/igreja.module.ts`
- Modify: `provisao_api/src/app.module.ts`

**Interfaces:**
- Consumes: `IgrejaService` (Task 2), `AdminKeyGuard` (Task 1), `CreateIgrejaDto`, `UpdateIgrejaDto` (Task 1)
- Consumes: `AuthGuard` from `src/auth/auth.guard`, `RolesGuard` + `ALL_ROLES` from `src/auth/guards/roles/roles.guard`, `Roles` from `src/auth/decorators/roles.decorator`

- [ ] **Step 1: Create `igreja.controller.ts`**

```typescript
// provisao_api/src/igreja/igreja.controller.ts
import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IgrejaService } from './igreja.service';
import { CreateIgrejaDto } from './dto/create-igreja.dto';
import { UpdateIgrejaDto } from './dto/update-igreja.dto';
import { AdminKeyGuard } from './guards/admin-key.guard';
import { AuthGuard } from 'src/auth/auth.guard';
import { ALL_ROLES, RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';

@Controller('igrejas')
export class IgrejaController {
  constructor(private readonly igrejaService: IgrejaService) {}

  @Post()
  @UseGuards(AdminKeyGuard)
  create(@Body() dto: CreateIgrejaDto) {
    return this.igrejaService.create(dto);
  }

  @Get('me')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(...ALL_ROLES)
  findMe(@Request() req) {
    return this.igrejaService.findMe(req.user.igreja_id);
  }

  @Patch('me')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Perfil.ADMINISTRADOR)
  updateMe(@Request() req, @Body() dto: UpdateIgrejaDto) {
    return this.igrejaService.updateMe(req.user.igreja_id, dto);
  }

  @Patch('me/logo')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Perfil.ADMINISTRADOR)
  @UseInterceptors(FileInterceptor('file'))
  updateLogo(@Request() req, @UploadedFile() file: Express.Multer.File) {
    return this.igrejaService.updateLogo(req.user.igreja_id, file);
  }

  @Get('me/congregacoes')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(...ALL_ROLES)
  findCongregacoes(@Request() req) {
    return this.igrejaService.findCongregacoes(req.user.igreja_id);
  }
}
```

- [ ] **Step 2: Create `igreja.module.ts`**

```typescript
// provisao_api/src/igreja/igreja.module.ts
import { Module } from '@nestjs/common';
import { IgrejaService } from './igreja.service';
import { IgrejaController } from './igreja.controller';
import { AdminKeyGuard } from './guards/admin-key.guard';
import { StorageModule } from 'src/storage/storage.module';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [StorageModule, AuthModule],
  controllers: [IgrejaController],
  providers: [IgrejaService, AdminKeyGuard],
})
export class IgrejaModule {}
```

- [ ] **Step 3: Register IgrejaModule in `app.module.ts`**

Add the import at the top of `src/app.module.ts`:
```typescript
import { IgrejaModule } from './igreja/igreja.module';
```

Add `IgrejaModule` to the `imports` array, after `LogsModule`:
```typescript
    LogsModule,
    IgrejaModule,
```

The full updated `imports` array in `app.module.ts`:
```typescript
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
    CatDespesaModule,
    CatReceitaModule,
    ContasModule,
    ReceitasModule,
    DespesasModule,
    VinculosMembresiaModule,
    AcoesModule,
    LancamentosModule,
    LogsModule,
    IgrejaModule,
  ],
```

- [ ] **Step 4: Run full test suite and build**

```bash
cd provisao_api && npx jest src/igreja --verbose
```

Expected: all tests pass.

```bash
cd provisao_api && npm run build
```

Expected: no TypeScript errors. Build succeeds.

- [ ] **Step 5: Commit Task 3**

```bash
cd /home/douglasboardman/github/provisao
git add provisao_api/src/igreja/igreja.controller.ts \
        provisao_api/src/igreja/igreja.module.ts \
        provisao_api/src/app.module.ts
git commit -m "feat(igreja): add IgrejaController, IgrejaModule and register in AppModule"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
|---|---|
| `AdminKeyGuard` — fail-closed, `X-Admin-Key` header | Task 1 |
| `CreateIgrejaDto` with all fields from schema | Task 1 |
| `UpdateIgrejaDto` omits `congregacao` and `vinculada_a` | Task 1 |
| `IgrejaService.create` — CNPJ uniqueness, vinculada_a validation | Task 2 |
| `IgrejaService.findMe` — NotFoundException | Task 2 |
| `IgrejaService.updateMe` — CNPJ uniqueness excluding self | Task 2 |
| `IgrejaService.updateLogo` — delegates to `StorageService` | Task 2 |
| `IgrejaService.findCongregacoes` — findMany by vinculada_a | Task 2 |
| `POST /igrejas` — AdminKeyGuard, no JWT | Task 3 |
| `GET /igrejas/me` — AuthGuard + RolesGuard, all perfis | Task 3 |
| `PATCH /igrejas/me` — AuthGuard + RolesGuard, ADMINISTRADOR only | Task 3 |
| `PATCH /igrejas/me/logo` — FileInterceptor, ADMINISTRADOR only | Task 3 |
| `GET /igrejas/me/congregacoes` — AuthGuard + RolesGuard, all perfis | Task 3 |
| Register `IgrejaModule` in `AppModule` | Task 3 |
