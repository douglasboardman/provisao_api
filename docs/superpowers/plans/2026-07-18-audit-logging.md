# Audit Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar automaticamente operações de escrita em `logs_atividades`, com logging explícito de eventos de login no `AuthService`.

**Architecture:** `AuditInterceptor` global intercepta POST/PATCH/DELETE em rotas autenticadas não-auth e escreve via `LogsService.registrar()` (fire-and-forget). `AuthService.signIn()` chama `registrar()` explicitamente para `LOGIN_SUCESSO` e `LOGIN_FALHA`.

**Tech Stack:** NestJS 11, Prisma, RxJS `tap`, `APP_INTERCEPTOR`

## Global Constraints

- TypeScript estrito — sem `any` implícito
- Multi-tenant: todo registro em `logs_atividades` exige `igreja_id` do JWT (`req.user.igreja_id`)
- Falha de logging nunca propaga exceção nem bloqueia a resposta ao cliente
- `usuario_id` em `logs_atividades` referencia `usuarios.id` — só logar quando o usuário for identificado

---

### Task 1: LogsService.registrar() + LogsModule export

**Files:**
- Modify: `src/logs/logs.service.ts`
- Modify: `src/logs/logs.module.ts`
- Create: `src/logs/logs.service.spec.ts`

**Interfaces:**
- Produces: `LogsService.registrar(data: RegistrarDto): Promise<void>` — usado por `AuditInterceptor` (Task 2) e `AuthService` (Task 3)

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/logs/logs.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { LogsService } from './logs.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { logs_atividades_acao } from '@prisma/client';

describe('LogsService.registrar', () => {
  let service: LogsService;
  let prisma: { logs_atividades: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      logs_atividades: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        LogsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(LogsService);
  });

  it('chama prisma.create com os dados corretos', async () => {
    await service.registrar({
      igreja_id: 'church-1',
      usuario_id: 'user-1',
      acao: logs_atividades_acao.CRIACAO,
      entidade_tipo: 'acoes',
      entidade_id: 'entity-1',
      detalhes: { endpoint: '/acoes', ip: '127.0.0.1' },
    });

    expect(prisma.logs_atividades.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        igreja_id: 'church-1',
        usuario_id: 'user-1',
        acao: logs_atividades_acao.CRIACAO,
        entidade_tipo: 'acoes',
        entidade_id: 'entity-1',
      }),
    });
  });

  it('não lança exceção quando Prisma falha', async () => {
    prisma.logs_atividades.create.mockRejectedValue(new Error('DB offline'));

    await expect(
      service.registrar({
        igreja_id: 'church-1',
        usuario_id: 'user-1',
        acao: logs_atividades_acao.CRIACAO,
        entidade_tipo: 'acoes',
        entidade_id: null,
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar falha**

```bash
cd provisao_api && npx jest logs.service.spec --no-coverage
```

Esperado: FAIL — `TypeError: service.registrar is not a function`

- [ ] **Step 3: Adicionar `registrar()` ao LogsService**

Em `src/logs/logs.service.ts`, substituir o conteúdo por:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { logs_atividades_acao } from '@prisma/client';

interface RegistrarDto {
  igreja_id: string;
  usuario_id: string;
  acao: logs_atividades_acao;
  entidade_tipo: string;
  entidade_id: string | null;
  detalhes?: Record<string, unknown>;
}

@Injectable()
export class LogsService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(data: RegistrarDto): Promise<void> {
    try {
      await this.prisma.logs_atividades.create({
        data: {
          igreja_id: data.igreja_id,
          usuario_id: data.usuario_id,
          acao: data.acao,
          entidade_tipo: data.entidade_tipo,
          entidade_id: data.entidade_id,
          detalhes: data.detalhes ?? undefined,
        },
      });
    } catch {
      // Logging failures must never surface to the caller
    }
  }

  async findAll(igreja_id: string, page = 1) {
    const take = 50;
    const skip = (page - 1) * take;
    const where = { igreja_id };
    const [data, total] = await Promise.all([
      this.prisma.logs_atividades.findMany({
        where, skip, take,
        orderBy: { created_at: 'desc' },
        include: { usuarios: { select: { nome_usuario: true, email_login: true } } },
      }),
      this.prisma.logs_atividades.count({ where }),
    ]);
    return { data, total, page, totalPages: Math.ceil(total / take) };
  }
}
```

- [ ] **Step 4: Exportar LogsService do LogsModule**

Em `src/logs/logs.module.ts`, substituir por:

```ts
import { Module } from '@nestjs/common';
import { LogsService } from './logs.service';
import { LogsController } from './logs.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [LogsController],
  providers: [LogsService],
  exports: [LogsService],
})
export class LogsModule {}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

```bash
cd provisao_api && npx jest logs.service.spec --no-coverage
```

Esperado: PASS (2 testes)

- [ ] **Step 6: Build check**

```bash
cd provisao_api && npm run build
```

Esperado: saída sem erros.

- [ ] **Step 7: Commit**

```bash
git add provisao_api/src/logs/logs.service.ts provisao_api/src/logs/logs.module.ts provisao_api/src/logs/logs.service.spec.ts
git commit -m "feat(logs): adiciona LogsService.registrar() e exporta LogsService"
```

---

### Task 2: AuditInterceptor + APP_INTERCEPTOR global

**Files:**
- Create: `src/logs/audit.interceptor.ts`
- Create: `src/logs/audit.interceptor.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `LogsService.registrar(data: RegistrarDto): Promise<void>` — definido em Task 1
- Produces: `AuditInterceptor` registrado globalmente via `APP_INTERCEPTOR`

- [ ] **Step 1: Escrever os testes que falham**

Criar `src/logs/audit.interceptor.spec.ts`:

```ts
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { logs_atividades_acao } from '@prisma/client';
import { AuditInterceptor } from './audit.interceptor';

describe('AuditInterceptor', () => {
  let interceptor: AuditInterceptor;
  let logsService: { registrar: jest.Mock };

  beforeEach(() => {
    logsService = { registrar: jest.fn().mockResolvedValue(undefined) };
    interceptor = new AuditInterceptor(logsService as never);
  });

  function makeContext(
    method: string,
    path: string,
    user?: { sub: string; igreja_id: string },
    params: Record<string, string> = {},
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method, path, url: path, ip: '127.0.0.1', user, params }),
      }),
    } as unknown as ExecutionContext;
  }

  function makeHandler(response: unknown): CallHandler {
    return { handle: () => of(response) };
  }

  it('não loga GET', (done) => {
    const ctx = makeContext('GET', '/acoes', { sub: 'u1', igreja_id: 'c1' });
    interceptor.intercept(ctx, makeHandler([])).subscribe(() => {
      expect(logsService.registrar).not.toHaveBeenCalled();
      done();
    });
  });

  it('não loga rotas /auth', (done) => {
    const ctx = makeContext('POST', '/auth/login', { sub: 'u1', igreja_id: 'c1' });
    interceptor.intercept(ctx, makeHandler({})).subscribe(() => {
      expect(logsService.registrar).not.toHaveBeenCalled();
      done();
    });
  });

  it('não loga sem req.user (não autenticado)', (done) => {
    const ctx = makeContext('POST', '/acoes', undefined);
    interceptor.intercept(ctx, makeHandler({ id: 'x' })).subscribe(() => {
      expect(logsService.registrar).not.toHaveBeenCalled();
      done();
    });
  });

  it('loga POST como CRIACAO com id da resposta', (done) => {
    const ctx = makeContext('POST', '/acoes', { sub: 'u1', igreja_id: 'c1' });
    interceptor.intercept(ctx, makeHandler({ id: 'new-id' })).subscribe(() => {
      expect(logsService.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          acao: logs_atividades_acao.CRIACAO,
          entidade_tipo: 'acoes',
          entidade_id: 'new-id',
          usuario_id: 'u1',
          igreja_id: 'c1',
        }),
      );
      done();
    });
  });

  it('loga PATCH como ATUALIZACAO com id dos params', (done) => {
    const ctx = makeContext('PATCH', '/acoes/abc-123', { sub: 'u1', igreja_id: 'c1' }, { id: 'abc-123' });
    interceptor.intercept(ctx, makeHandler({ id: 'abc-123', nome: 'updated' })).subscribe(() => {
      expect(logsService.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          acao: logs_atividades_acao.ATUALIZACAO,
          entidade_id: 'abc-123',
        }),
      );
      done();
    });
  });

  it('loga DELETE como EXCLUSAO com id dos params', (done) => {
    const ctx = makeContext('DELETE', '/lancamentos/def-456', { sub: 'u1', igreja_id: 'c1' }, { id: 'def-456' });
    interceptor.intercept(ctx, makeHandler({ message: 'deleted' })).subscribe(() => {
      expect(logsService.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          acao: logs_atividades_acao.EXCLUSAO,
          entidade_tipo: 'lancamentos',
          entidade_id: 'def-456',
        }),
      );
      done();
    });
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar falha**

```bash
cd provisao_api && npx jest audit.interceptor.spec --no-coverage
```

Esperado: FAIL — `Cannot find module './audit.interceptor'`

- [ ] **Step 3: Criar o AuditInterceptor**

Criar `src/logs/audit.interceptor.ts`:

```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { logs_atividades_acao } from '@prisma/client';
import { LogsService } from './logs.service';

const HTTP_TO_ACAO: Record<string, logs_atividades_acao> = {
  POST: logs_atividades_acao.CRIACAO,
  PATCH: logs_atividades_acao.ATUALIZACAO,
  PUT: logs_atividades_acao.ATUALIZACAO,
  DELETE: logs_atividades_acao.EXCLUSAO,
};

interface JwtUser {
  sub: string;
  igreja_id: string;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly logsService: LogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      path: string;
      url: string;
      ip: string;
      params: Record<string, string>;
      user?: JwtUser;
    }>();

    const acao = HTTP_TO_ACAO[req.method];
    if (!acao || !req.user || req.path.startsWith('/auth')) {
      return next.handle();
    }

    const user = req.user;

    return next.handle().pipe(
      tap((response: unknown) => {
        const entidadeTipo = req.path.split('/').filter(Boolean)[0] ?? 'unknown';
        const entidadeId =
          req.method === 'POST'
            ? ((response as Record<string, unknown>)?.id as string | null) ?? null
            : req.params?.id ?? null;

        this.logsService
          .registrar({
            igreja_id: user.igreja_id,
            usuario_id: user.sub,
            acao,
            entidade_tipo: entidadeTipo,
            entidade_id: entidadeId,
            detalhes: { endpoint: req.url, ip: req.ip },
          })
          .catch(() => {});
      }),
    );
  }
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

```bash
cd provisao_api && npx jest audit.interceptor.spec --no-coverage
```

Esperado: PASS (6 testes)

- [ ] **Step 5: Registrar APP_INTERCEPTOR no AppModule**

Em `src/app.module.ts`, adicionar os imports e o provider:

```ts
// Adicionar aos imports no topo do arquivo:
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './logs/audit.interceptor';
```

No `@Module`, adicionar `providers`:

```ts
@Module({
  imports: [
    // ... todos os imports existentes, sem alterar ...
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AppModule {}
```

- [ ] **Step 6: Build check**

```bash
cd provisao_api && npm run build
```

Esperado: saída sem erros.

- [ ] **Step 7: Commit**

```bash
git add provisao_api/src/logs/audit.interceptor.ts provisao_api/src/logs/audit.interceptor.spec.ts provisao_api/src/app.module.ts
git commit -m "feat(logs): adiciona AuditInterceptor global via APP_INTERCEPTOR"
```

---

### Task 3: Login audit logging no AuthService

**Files:**
- Modify: `src/auth/auth.module.ts`
- Modify: `src/auth/auth.service.ts`

**Interfaces:**
- Consumes: `LogsService.registrar(data: RegistrarDto): Promise<void>` — definido em Task 1

- [ ] **Step 1: Importar LogsModule no AuthModule**

Substituir o conteúdo de `src/auth/auth.module.ts` por:

```ts
import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EmailModule } from 'src/email/email.module';
import { LogsModule } from 'src/logs/logs.module';

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1h' },
      }),
      inject: [ConfigService],
    }),
    EmailModule,
    LogsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
```

- [ ] **Step 2: Injetar LogsService e logar eventos de login no AuthService**

Em `src/auth/auth.service.ts`, adicionar o import:

```ts
import { LogsService } from 'src/logs/logs.service';
import { logs_atividades_acao } from '@prisma/client';
```

Adicionar `LogsService` ao construtor (após `EmailService`):

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly jwtService: JwtService,
  private readonly configService: ConfigService,
  private readonly emailService: EmailService,
  private readonly logsService: LogsService,
) {}
```

Substituir o método `signIn` por:

```ts
async signIn(login: string, pass: string): Promise<{ access_token: string }> {
  const isEmail = Email.isEmail(login);

  const user = isEmail
    ? await this.prisma.usuarios.findFirst({ where: { email_login: login } })
    : await this.prisma.usuarios.findFirst({ where: { nome_usuario: login } });

  if (!user) throw new UnauthorizedException('Credenciais inválidas.');

  if (!user.ativo) {
    await this.logsService.registrar({
      igreja_id: user.igreja_id,
      usuario_id: user.id,
      acao: logs_atividades_acao.LOGIN_FALHA,
      entidade_tipo: 'auth',
      entidade_id: user.id,
    });
    throw new UnauthorizedException('Conta inativa. Aguarde a aprovação do administrador.');
  }

  const isPasswordMatching = await bcrypt.compare(pass, user.senha_hash);
  if (!isPasswordMatching) {
    await this.logsService.registrar({
      igreja_id: user.igreja_id,
      usuario_id: user.id,
      acao: logs_atividades_acao.LOGIN_FALHA,
      entidade_tipo: 'auth',
      entidade_id: user.id,
    });
    throw new UnauthorizedException('Credenciais inválidas.');
  }

  const payload = {
    sub: user.id,
    username: user.nome_usuario,
    login: user.email_login,
    perfil: user.perfil,
    igreja_id: user.igreja_id,
  };

  const access_token = await this.jwtService.signAsync(payload);

  await this.logsService.registrar({
    igreja_id: user.igreja_id,
    usuario_id: user.id,
    acao: logs_atividades_acao.LOGIN_SUCESSO,
    entidade_tipo: 'auth',
    entidade_id: user.id,
  });

  return { access_token };
}
```

- [ ] **Step 3: Build check**

```bash
cd provisao_api && npm run build
```

Esperado: saída sem erros.

- [ ] **Step 4: Rodar todos os testes**

```bash
cd provisao_api && npx jest --no-coverage
```

Esperado: todos os testes passam (mínimo: os 8 testes novos de Task 1 e Task 2).

- [ ] **Step 5: Commit**

```bash
git add provisao_api/src/auth/auth.module.ts provisao_api/src/auth/auth.service.ts
git commit -m "feat(auth): registra LOGIN_SUCESSO e LOGIN_FALHA em logs_atividades"
```
