# Eventos de Membresia — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrar `vinculos_membresia` (CRUD estático) para `eventos_membresia` (event sourcing) com histórico completo de admissão, demissão e mudança de rol, alinhado à CI/IPB Arts. 16, 17, 23 e 24.

**Architecture:** Cada transição de membresia vira um evento imutável na tabela `eventos_membresia`. O estado atual de um membro é derivado do seu último evento (`created_at DESC`). Três tipos de evento (`ADMISSAO`, `DEMISSAO`, `MUDANCA_DE_ROL`) com 20 motivações categorizadas por prefixo (`ADM_`, `DEM_`, `OUT_`). Frontend com 3 modais dinâmicos (Admitir, Demitir, Mudar Rol) e restrição de edição/exclusão ao último evento por pessoa.

**Tech Stack:** NestJS + Prisma + PostgreSQL (backend), React + TanStack Query + React Hook Form + Zod + shadcn/ui (frontend)

## Global Constraints

- Multi-tenant por `igreja_id` extraído do JWT — toda query filtra por `igreja_id`
- Validação via Zod + `nestjs-zod` com `createZodDto`
- RBAC: class-level `@Roles` para view (6 perfis), method-level para CUD
- Usar `prisma db push` para sync de schema (sem migrations formais em dev)
- Não quebrar a tabela `vinculos_membresia` até a migração de dados estar verificada
- Manter o `AuditInterceptor` global que loga em `logs_atividades`

## File Structure

**Backend — criar:**
- `provisao_api/src/eventos-membresia/eventos-membresia.module.ts` — módulo NestJS
- `provisao_api/src/eventos-membresia/eventos-membresia.service.ts` — lógica de negócio + event sourcing
- `provisao_api/src/eventos-membresia/eventos-membresia.controller.ts` — endpoints REST
- `provisao_api/src/eventos-membresia/dto/create-evento-membresia.dto.ts` — validação Zod
- `provisao_api/src/eventos-membresia/dto/update-evento-membresia.dto.ts` — partial do create
- `provisao_api/src/eventos-membresia/eventos-membresia.service.spec.ts` — testes unitários

**Backend — modificar:**
- `provisao_api/prisma/schema.prisma` — novos enums + modelo `eventos_membresia`
- `provisao_api/src/app.module.ts` — registrar novo módulo

**Frontend — criar:**
- `provisao_frontend/src/pages/membresia/GestaoMembresiaPage.tsx` — página principal com 3 modais
- `provisao_frontend/src/api/eventos-membresia.ts` — API client

**Frontend — modificar:**
- `provisao_frontend/src/types/enums.ts` — novos enums
- `provisao_frontend/src/types/models.ts` — interface `EventoMembresia`
- `provisao_frontend/src/lib/permissions.ts` — módulo `"eventos-membresia"`
- `provisao_frontend/src/App.tsx` — rota
- `provisao_frontend/src/components/layout/Sidebar.tsx` — menu entry

**Remover (cleanup final):**
- `provisao_api/src/vinculos-membresia/` — diretório inteiro
- `provisao_frontend/src/pages/configuracoes/VinculosPage.tsx`
- `provisao_frontend/src/api/vinculos-membresia.ts`
- Enums e modelo antigos do `schema.prisma`

---

### Task 1: Schema — Novos enums e modelo eventos_membresia

**Files:**
- Modify: `provisao_api/prisma/schema.prisma`

**Interfaces:**
- Produces: Enums `membresia_tipo_evento`, `membresia_rol`, `membresia_motivacao_evento` e modelo `eventos_membresia` disponíveis via `@prisma/client` após `prisma generate`.

- [ ] **Step 1: Adicionar os 3 novos enums ao schema.prisma**

Inserir após o último enum existente (após `vinculos_membresia_modalidade_demissao`):

```prisma
enum membresia_tipo_evento {
  ADMISSAO
  DEMISSAO
  MUDANCA_DE_ROL
}

enum membresia_rol {
  COMUNGANTES
  NAO_COMUNGANTES
  ROL_SEPARADO
  EXCLUIDOS
}

enum membresia_motivacao_evento {
  // Admissão de Comungantes (CI/IPB Art. 16)
  ADM_PROFISSAO_DE_FE
  ADM_PROFISSAO_DE_FE_E_BATISMO
  ADM_CARTA_DE_TRANSFERENCIA
  ADM_JURISDICAO_A_PEDIDO
  ADM_JURISDICAO_EX_OFFICIO
  ADM_RESTAURACAO
  ADM_DESIGNACAO_PRESBITERIO
  // Admissão de Não Comungantes (CI/IPB Art. 17)
  ADM_BATISMO_NA_INFANCIA
  ADM_TRANSFERENCIA_PAIS_OU_RESPONSAVEIS
  ADM_JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS
  // Demissão de Comungantes (CI/IPB Art. 23)
  DEM_EXCLUSAO_POR_DISCIPLINA
  DEM_EXCLUSAO_A_PEDIDO
  DEM_EXCLUSAO_POR_AUSENCIA
  DEM_CARTA_DE_TRANSFERENCIA
  DEM_JURISDICAO_ASSUMIDA
  DEM_FALECIMENTO
  // Demissão de Não Comungantes (CI/IPB Art. 24)
  DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS
  DEM_DEZOITO_ANOS_COMPLETOS
  DEM_SOLICITACAO_PAIS_OUTRA_COMUNIDADE
  // Outros (CI/IPB Art. 23 §2°)
  OUT_PARADEIRO_IGNORADO
}
```

- [ ] **Step 2: Adicionar o modelo eventos_membresia ao schema.prisma**

Inserir após o modelo `vinculos_membresia` (que será mantido temporariamente):

```prisma
model eventos_membresia {
  id               String                      @id @default(uuid())
  igreja_id        String
  pessoa_id        String
  tipo_evento      membresia_tipo_evento
  rol              membresia_rol
  rol_origem       membresia_rol?
  motivacao_evento membresia_motivacao_evento
  data_evento      DateTime                    @db.Date
  igreja_origem    String?                     @db.VarChar(255)
  igreja_destino   String?                     @db.VarChar(255)
  observacoes      String?
  created_at       DateTime                    @default(now())
  updated_at       DateTime                    @updatedAt

  igreja           igreja                      @relation(fields: [igreja_id], references: [id], onDelete: Cascade, onUpdate: NoAction, map: "eventos_membresia_igreja_fk")
  pessoas          pessoas                     @relation(fields: [pessoa_id], references: [id], onDelete: Cascade, onUpdate: NoAction, map: "eventos_membresia_pessoa_fk")

  @@index([pessoa_id, created_at(sort: Desc)], map: "eventos_membresia_pessoa_created")
  @@index([igreja_id], map: "eventos_membresia_igreja_id")
}
```

- [ ] **Step 3: Adicionar relação reversa nos modelos igreja e pessoas**

No modelo `igreja`, adicionar junto às relações existentes:
```prisma
  eventos_membresia eventos_membresia[]
```

No modelo `pessoas`, adicionar junto às relações existentes:
```prisma
  eventos_membresia eventos_membresia[]
```

- [ ] **Step 4: Executar prisma db push e generate**

```bash
cd provisao_api
npx prisma db push
```

Expected: "Your database is now in sync with your Prisma schema." — cria a nova tabela sem alterar a antiga.

- [ ] **Step 5: Verificar que a tabela foi criada**

```bash
cd provisao_api
npx prisma db execute --stdin <<'SQL'
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'eventos_membresia'
ORDER BY ordinal_position;
SQL
```

Expected: 13 colunas (id, igreja_id, pessoa_id, tipo_evento, rol, rol_origem, motivacao_evento, data_evento, igreja_origem, igreja_destino, observacoes, created_at, updated_at).

- [ ] **Step 6: Commit**

```bash
git add provisao_api/prisma/schema.prisma
git commit -m "feat(schema): add eventos_membresia model and new membership enums

New event-sourced model for membership tracking alongside existing
vinculos_membresia (kept temporarily for data migration).

Three new enums: membresia_tipo_evento, membresia_rol,
membresia_motivacao_evento (20 values with ADM_/DEM_/OUT_ prefixes
covering CI/IPB Arts. 16, 17, 23, 24)."
```

---

### Task 2: Backend — Service, DTOs, Controller e Module

**Files:**
- Create: `provisao_api/src/eventos-membresia/dto/create-evento-membresia.dto.ts`
- Create: `provisao_api/src/eventos-membresia/dto/update-evento-membresia.dto.ts`
- Create: `provisao_api/src/eventos-membresia/eventos-membresia.service.ts`
- Create: `provisao_api/src/eventos-membresia/eventos-membresia.service.spec.ts`
- Create: `provisao_api/src/eventos-membresia/eventos-membresia.controller.ts`
- Create: `provisao_api/src/eventos-membresia/eventos-membresia.module.ts`
- Modify: `provisao_api/src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService` (global), `@prisma/client` types from Task 1
- Produces: REST endpoints `POST/GET/PATCH/DELETE /eventos-membresia` consumed pelo frontend na Task 4

- [ ] **Step 1: Criar o DTO de criação**

Create `provisao_api/src/eventos-membresia/dto/create-evento-membresia.dto.ts`:

```typescript
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  membresia_tipo_evento as TipoEvento,
  membresia_rol as MembresiaRol,
  membresia_motivacao_evento as MotivacaoEvento,
} from '@prisma/client';

export const CreateEventoMembresiaSchema = z.object({
  pessoa_id: z.string().uuid("O campo 'pessoa_id' deve ser um UUID válido."),
  tipo_evento: z.nativeEnum(TipoEvento, { error: 'O tipo de evento informado é inválido.' }),
  rol: z.nativeEnum(MembresiaRol, { error: 'O rol informado é inválido.' }),
  rol_origem: z.nativeEnum(MembresiaRol).optional(),
  motivacao_evento: z.nativeEnum(MotivacaoEvento, { error: 'A motivação informada é inválida.' }),
  data_evento: z.coerce.date({ error: "O campo 'data_evento' deve ser uma data válida." }),
  igreja_origem: z.string().max(255).optional(),
  igreja_destino: z.string().max(255).optional(),
  observacoes: z.string().optional(),
});

export class CreateEventoMembresiaDto extends createZodDto(CreateEventoMembresiaSchema) {}
```

- [ ] **Step 2: Criar o DTO de atualização**

Create `provisao_api/src/eventos-membresia/dto/update-evento-membresia.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { CreateEventoMembresiaSchema } from './create-evento-membresia.dto';

export class UpdateEventoMembresiaDto extends createZodDto(CreateEventoMembresiaSchema.partial()) {}
```

- [ ] **Step 3: Criar o service com lógica de event sourcing**

Create `provisao_api/src/eventos-membresia/eventos-membresia.service.ts`:

```typescript
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventoMembresiaDto } from './dto/create-evento-membresia.dto';
import { UpdateEventoMembresiaDto } from './dto/update-evento-membresia.dto';
import {
  membresia_tipo_evento as TipoEvento,
  membresia_rol as MembresiaRol,
  membresia_motivacao_evento as MotivacaoEvento,
} from '@prisma/client';

const DEMISSAO_ROL_MAP: Partial<Record<MotivacaoEvento, MembresiaRol>> = {
  DEM_EXCLUSAO_POR_DISCIPLINA: MembresiaRol.EXCLUIDOS,
  DEM_EXCLUSAO_A_PEDIDO: MembresiaRol.EXCLUIDOS,
  DEM_EXCLUSAO_POR_AUSENCIA: MembresiaRol.EXCLUIDOS,
  DEM_CARTA_DE_TRANSFERENCIA: MembresiaRol.ROL_SEPARADO,
  DEM_JURISDICAO_ASSUMIDA: MembresiaRol.ROL_SEPARADO,
  DEM_FALECIMENTO: MembresiaRol.ROL_SEPARADO,
  DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS: MembresiaRol.ROL_SEPARADO,
  DEM_DEZOITO_ANOS_COMPLETOS: MembresiaRol.ROL_SEPARADO,
  DEM_SOLICITACAO_PAIS_OUTRA_COMUNIDADE: MembresiaRol.ROL_SEPARADO,
};

@Injectable()
export class EventosMembresiaService {
  constructor(private readonly prisma: PrismaService) {}

  async create(igrejaId: string, dto: CreateEventoMembresiaDto) {
    const pessoa = await this.prisma.pessoas.findFirst({
      where: { id: dto.pessoa_id, igreja_id: igrejaId },
    });
    if (!pessoa) {
      throw new BadRequestException('Pessoa não encontrada nesta igreja.');
    }

    this.validateMotivacaoPrefix(dto.tipo_evento, dto.motivacao_evento);

    const data: any = {
      igreja_id: igrejaId,
      pessoa_id: dto.pessoa_id,
      tipo_evento: dto.tipo_evento,
      motivacao_evento: dto.motivacao_evento,
      data_evento: dto.data_evento,
      igreja_origem: dto.igreja_origem,
      igreja_destino: dto.igreja_destino,
      observacoes: dto.observacoes,
    };

    if (dto.tipo_evento === TipoEvento.DEMISSAO) {
      const rolDemissao = DEMISSAO_ROL_MAP[dto.motivacao_evento];
      if (!rolDemissao) {
        throw new BadRequestException('Motivação de demissão inválida.');
      }
      data.rol = rolDemissao;
    } else if (dto.tipo_evento === TipoEvento.MUDANCA_DE_ROL) {
      if (dto.rol === MembresiaRol.EXCLUIDOS) {
        throw new BadRequestException(
          'EXCLUIDOS é reservado para eventos de demissão. Use o modal de demissão.',
        );
      }
      const ultimoEvento = await this.getUltimoEvento(dto.pessoa_id, igrejaId);
      data.rol_origem = ultimoEvento?.rol ?? null;
      data.rol = dto.rol;
    } else {
      data.rol = dto.rol;
    }

    return this.prisma.eventos_membresia.create({
      data,
      include: { pessoas: { select: { id: true, nome_completo: true } } },
    });
  }

  async findAll(igrejaId: string) {
    return this.prisma.eventos_membresia.findMany({
      where: { igreja_id: igrejaId },
      include: { pessoas: { select: { id: true, nome_completo: true } } },
      orderBy: { created_at: 'desc' },
    });
  }

  async findByPessoa(pessoaId: string, igrejaId: string) {
    return this.prisma.eventos_membresia.findMany({
      where: { pessoa_id: pessoaId, igreja_id: igrejaId },
      orderBy: { created_at: 'asc' },
    });
  }

  async findOne(id: string, igrejaId: string) {
    const evento = await this.prisma.eventos_membresia.findFirst({
      where: { id, igreja_id: igrejaId },
      include: { pessoas: { select: { id: true, nome_completo: true } } },
    });
    if (!evento) {
      throw new NotFoundException('Evento de membresia não encontrado.');
    }
    return evento;
  }

  async update(id: string, igrejaId: string, dto: UpdateEventoMembresiaDto) {
    const evento = await this.findOne(id, igrejaId);
    await this.assertIsLastEvent(evento.id, evento.pessoa_id, igrejaId);

    if (dto.tipo_evento && dto.motivacao_evento) {
      this.validateMotivacaoPrefix(dto.tipo_evento, dto.motivacao_evento);
    }

    if (dto.tipo_evento === TipoEvento.DEMISSAO && dto.motivacao_evento) {
      const rolDemissao = DEMISSAO_ROL_MAP[dto.motivacao_evento];
      if (rolDemissao) dto.rol = rolDemissao as any;
    }

    return this.prisma.eventos_membresia.update({
      where: { id },
      data: dto as any,
      include: { pessoas: { select: { id: true, nome_completo: true } } },
    });
  }

  async remove(id: string, igrejaId: string) {
    const evento = await this.findOne(id, igrejaId);
    await this.assertIsLastEvent(evento.id, evento.pessoa_id, igrejaId);

    await this.prisma.eventos_membresia.delete({ where: { id } });
    return { message: 'Evento de membresia excluído com sucesso.' };
  }

  private async getUltimoEvento(pessoaId: string, igrejaId: string) {
    return this.prisma.eventos_membresia.findFirst({
      where: { pessoa_id: pessoaId, igreja_id: igrejaId },
      orderBy: { created_at: 'desc' },
    });
  }

  private async assertIsLastEvent(
    eventoId: string,
    pessoaId: string,
    igrejaId: string,
  ) {
    const ultimo = await this.getUltimoEvento(pessoaId, igrejaId);
    if (ultimo && ultimo.id !== eventoId) {
      throw new ForbiddenException(
        'Apenas o último evento de uma pessoa pode ser editado ou excluído.',
      );
    }
  }

  private validateMotivacaoPrefix(
    tipo: TipoEvento,
    motivacao: MotivacaoEvento,
  ) {
    const mot = motivacao as string;
    if (tipo === TipoEvento.ADMISSAO && !mot.startsWith('ADM_')) {
      throw new BadRequestException(
        'Eventos de admissão requerem motivação com prefixo ADM_.',
      );
    }
    if (tipo === TipoEvento.DEMISSAO && !mot.startsWith('DEM_')) {
      throw new BadRequestException(
        'Eventos de demissão requerem motivação com prefixo DEM_.',
      );
    }
    if (
      tipo === TipoEvento.MUDANCA_DE_ROL &&
      !mot.startsWith('ADM_') &&
      !mot.startsWith('OUT_')
    ) {
      throw new BadRequestException(
        'Eventos de mudança de rol requerem motivação com prefixo ADM_ ou OUT_.',
      );
    }
  }
}
```

- [ ] **Step 4: Criar testes unitários do service**

Create `provisao_api/src/eventos-membresia/eventos-membresia.service.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { EventosMembresiaService } from './eventos-membresia.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  membresia_tipo_evento as TipoEvento,
  membresia_rol as MembresiaRol,
  membresia_motivacao_evento as MotivacaoEvento,
} from '@prisma/client';

const IGREJA_ID = 'igreja-uuid';
const PESSOA_ID = 'pessoa-uuid';

const mockPrisma = {
  pessoas: { findFirst: jest.fn() },
  eventos_membresia: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

describe('EventosMembresiaService', () => {
  let service: EventosMembresiaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventosMembresiaService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(EventosMembresiaService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    const baseDto = {
      pessoa_id: PESSOA_ID,
      tipo_evento: TipoEvento.ADMISSAO,
      rol: MembresiaRol.COMUNGANTES,
      motivacao_evento: MotivacaoEvento.ADM_PROFISSAO_DE_FE,
      data_evento: new Date('2025-01-15'),
    };

    it('should reject if pessoa not in igreja', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue(null);
      await expect(service.create(IGREJA_ID, baseDto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject ADM motivacao for DEMISSAO', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.DEMISSAO,
        motivacao_evento: MotivacaoEvento.ADM_PROFISSAO_DE_FE,
      };
      await expect(service.create(IGREJA_ID, dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject DEM motivacao for ADMISSAO', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      const dto = {
        ...baseDto,
        motivacao_evento: MotivacaoEvento.DEM_EXCLUSAO_POR_DISCIPLINA,
      };
      await expect(service.create(IGREJA_ID, dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should auto-assign EXCLUIDOS for DEM_EXCLUSAO_POR_DISCIPLINA', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.DEMISSAO,
        motivacao_evento: MotivacaoEvento.DEM_EXCLUSAO_POR_DISCIPLINA,
      };
      await service.create(IGREJA_ID, dto as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rol: MembresiaRol.EXCLUIDOS }),
        }),
      );
    });

    it('should auto-assign ROL_SEPARADO for DEM_FALECIMENTO', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.DEMISSAO,
        motivacao_evento: MotivacaoEvento.DEM_FALECIMENTO,
      };
      await service.create(IGREJA_ID, dto as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rol: MembresiaRol.ROL_SEPARADO }),
        }),
      );
    });

    it('should reject EXCLUIDOS as rol for MUDANCA_DE_ROL', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.findFirst.mockResolvedValue({
        rol: MembresiaRol.COMUNGANTES,
      });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.MUDANCA_DE_ROL,
        rol: MembresiaRol.EXCLUIDOS,
        motivacao_evento: MotivacaoEvento.ADM_PROFISSAO_DE_FE,
      };
      await expect(service.create(IGREJA_ID, dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should auto-fill rol_origem for MUDANCA_DE_ROL', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.findFirst.mockResolvedValue({
        rol: MembresiaRol.NAO_COMUNGANTES,
      });
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.MUDANCA_DE_ROL,
        rol: MembresiaRol.COMUNGANTES,
        motivacao_evento: MotivacaoEvento.ADM_PROFISSAO_DE_FE,
      };
      await service.create(IGREJA_ID, dto as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rol_origem: MembresiaRol.NAO_COMUNGANTES,
          }),
        }),
      );
    });

    it('should allow OUT_ motivacao for MUDANCA_DE_ROL', async () => {
      mockPrisma.pessoas.findFirst.mockResolvedValue({ id: PESSOA_ID });
      mockPrisma.eventos_membresia.findFirst.mockResolvedValue({
        rol: MembresiaRol.COMUNGANTES,
      });
      mockPrisma.eventos_membresia.create.mockResolvedValue({ id: 'new-id' });
      const dto = {
        ...baseDto,
        tipo_evento: TipoEvento.MUDANCA_DE_ROL,
        rol: MembresiaRol.ROL_SEPARADO,
        motivacao_evento: MotivacaoEvento.OUT_PARADEIRO_IGNORADO,
      };
      await service.create(IGREJA_ID, dto as any);
      expect(mockPrisma.eventos_membresia.create).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should reject deleting non-last event', async () => {
      mockPrisma.eventos_membresia.findFirst
        .mockResolvedValueOnce({ id: 'old-event', pessoa_id: PESSOA_ID })
        .mockResolvedValueOnce({ id: 'newer-event', pessoa_id: PESSOA_ID });
      await expect(service.remove('old-event', IGREJA_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
```

- [ ] **Step 5: Executar os testes**

```bash
cd provisao_api
npx jest --testPathPattern eventos-membresia --verbose
```

Expected: All tests pass.

- [ ] **Step 6: Criar o controller**

Create `provisao_api/src/eventos-membresia/eventos-membresia.controller.ts`:

```typescript
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { EventosMembresiaService } from './eventos-membresia.service';
import { CreateEventoMembresiaDto } from './dto/create-evento-membresia.dto';
import { UpdateEventoMembresiaDto } from './dto/update-evento-membresia.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { perfil } from '@prisma/client';

const {
  ADMINISTRADOR,
  GESTOR,
  OPERADOR,
  SECRETARIO,
  TESOUREIRO,
  AUDITOR,
} = perfil;

@Controller('eventos-membresia')
@UseGuards(AuthGuard, RolesGuard)
@Roles(ADMINISTRADOR, GESTOR, OPERADOR, SECRETARIO, TESOUREIRO, AUDITOR)
export class EventosMembresiaController {
  constructor(private readonly service: EventosMembresiaService) {}

  @Post()
  @Roles(ADMINISTRADOR, GESTOR, SECRETARIO)
  create(@Req() req, @Body() dto: CreateEventoMembresiaDto) {
    return this.service.create(req.user.igreja_id, dto);
  }

  @Get()
  findAll(@Req() req) {
    return this.service.findAll(req.user.igreja_id);
  }

  @Get(':id')
  findOne(@Req() req, @Param('id') id: string) {
    return this.service.findOne(id, req.user.igreja_id);
  }

  @Get('pessoa/:pessoaId')
  findByPessoa(@Req() req, @Param('pessoaId') pessoaId: string) {
    return this.service.findByPessoa(pessoaId, req.user.igreja_id);
  }

  @Patch(':id')
  @Roles(ADMINISTRADOR, GESTOR, SECRETARIO)
  update(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: UpdateEventoMembresiaDto,
  ) {
    return this.service.update(id, req.user.igreja_id, dto);
  }

  @Delete(':id')
  @Roles(ADMINISTRADOR, SECRETARIO)
  remove(@Req() req, @Param('id') id: string) {
    return this.service.remove(id, req.user.igreja_id);
  }
}
```

- [ ] **Step 7: Criar o module e registrar no AppModule**

Create `provisao_api/src/eventos-membresia/eventos-membresia.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { EventosMembresiaService } from './eventos-membresia.service';
import { EventosMembresiaController } from './eventos-membresia.controller';

@Module({
  controllers: [EventosMembresiaController],
  providers: [EventosMembresiaService],
})
export class EventosMembresiaModule {}
```

In `provisao_api/src/app.module.ts`, add the import:

```typescript
import { EventosMembresiaModule } from './eventos-membresia/eventos-membresia.module';
```

And add `EventosMembresiaModule` to the `imports` array in `@Module`.

- [ ] **Step 8: Verificar compilação do backend**

```bash
cd provisao_api
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 9: Testar endpoint com curl**

Start the server and test:

```bash
# Listar eventos (deve retornar [])
curl -s http://localhost:3000/eventos-membresia \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected: `[]`

- [ ] **Step 10: Commit**

```bash
git add provisao_api/src/eventos-membresia/ provisao_api/src/app.module.ts
git commit -m "feat(eventos-membresia): add service, controller, DTOs and unit tests

Event-sourced membership module with:
- Prefix-based motivacao validation (ADM_/DEM_/OUT_)
- Auto rol assignment for DEMISSAO events
- Auto rol_origem fill for MUDANCA_DE_ROL
- Last-event-only edit/delete restriction
- 8 unit tests covering business rules"
```

---

### Task 3: Migração de Dados

**Files:**
- Execute: SQL script (não versionado — executar diretamente)

**Interfaces:**
- Consumes: Tabela `vinculos_membresia` (dados existentes) e tabela `eventos_membresia` (Task 1)
- Produces: Dados migrados para `eventos_membresia`

- [ ] **Step 1: Verificar quantidade de registros existentes**

```bash
cd provisao_api
npx prisma db execute --stdin <<'SQL'
SELECT count(*) as total,
       count(data_demissao) as com_demissao
FROM vinculos_membresia;
SQL
```

Expected: Contagem de registros totais e quantos têm data_demissao preenchida.

- [ ] **Step 2: Executar migração — criar eventos de ADMISSAO**

Para cada registro existente, criar um evento de ADMISSAO. A coluna `modalidade_admissao` é mapeada para `motivacao_evento` com prefixo `ADM_`:

```bash
cd provisao_api
npx prisma db execute --stdin <<'SQL'
INSERT INTO eventos_membresia (
  id, igreja_id, pessoa_id, tipo_evento, rol, motivacao_evento,
  data_evento, igreja_origem, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  igreja_id,
  pessoa_id,
  'ADMISSAO'::membresia_tipo_evento,
  rol::text::membresia_rol,
  CASE modalidade_admissao::text
    WHEN 'BATISMO' THEN
      CASE WHEN rol::text = 'NAO_COMUNGANTES'
        THEN 'ADM_BATISMO_NA_INFANCIA'
        ELSE 'ADM_PROFISSAO_DE_FE_E_BATISMO'
      END
    WHEN 'PROFISSAO_DE_FE'                             THEN 'ADM_PROFISSAO_DE_FE'
    WHEN 'BATISMO_E_PROFISSAO_DE_FE'                   THEN 'ADM_PROFISSAO_DE_FE_E_BATISMO'
    WHEN 'CARTA_DE_TRANSFERENCIA'                      THEN 'ADM_CARTA_DE_TRANSFERENCIA'
    WHEN 'JURISDICAO_A_PEDIDO'                         THEN 'ADM_JURISDICAO_A_PEDIDO'
    WHEN 'JURISDICAO_EX_OFFICIO'                       THEN 'ADM_JURISDICAO_EX_OFFICIO'
    WHEN 'RESTAURACAO'                                 THEN 'ADM_RESTAURACAO'
    WHEN 'DESIGNACAO_PRESBITERIO'                      THEN 'ADM_DESIGNACAO_PRESBITERIO'
    WHEN 'BATISMO_NA_INFANCIA'                         THEN 'ADM_BATISMO_NA_INFANCIA'
    WHEN 'TRANSFERENCIA_PAIS_OU_RESPONSAVEIS'          THEN 'ADM_TRANSFERENCIA_PAIS_OU_RESPONSAVEIS'
    WHEN 'JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS' THEN 'ADM_JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS'
  END::membresia_motivacao_evento,
  data_admissao,
  igreja_origem,
  created_at,
  updated_at
FROM vinculos_membresia;
SQL
```

- [ ] **Step 3: Executar migração — criar eventos de DEMISSAO (onde aplicável)**

Para registros que têm `data_demissao` e `modalidade_demissao`, criar um segundo evento:

```bash
cd provisao_api
npx prisma db execute --stdin <<'SQL'
INSERT INTO eventos_membresia (
  id, igreja_id, pessoa_id, tipo_evento, rol, motivacao_evento,
  data_evento, igreja_destino, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  igreja_id,
  pessoa_id,
  'DEMISSAO'::membresia_tipo_evento,
  CASE modalidade_demissao::text
    WHEN 'EXCLUSAO_POR_DISCIPLINA' THEN 'EXCLUIDOS'
    WHEN 'EXCLUSAO_A_PEDIDO'       THEN 'EXCLUIDOS'
    WHEN 'EXCLUSAO_POR_AUSENCIA'   THEN 'EXCLUIDOS'
    ELSE 'ROL_SEPARADO'
  END::membresia_rol,
  CASE modalidade_demissao::text
    WHEN 'EXCLUSAO_POR_DISCIPLINA'                     THEN 'DEM_EXCLUSAO_POR_DISCIPLINA'
    WHEN 'EXCLUSAO_A_PEDIDO'                           THEN 'DEM_EXCLUSAO_A_PEDIDO'
    WHEN 'EXCLUSAO_POR_AUSENCIA'                       THEN 'DEM_EXCLUSAO_POR_AUSENCIA'
    WHEN 'CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS' THEN 'DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS'
    WHEN 'DEZOITO_ANOS_COMPLETOS'                      THEN 'DEM_DEZOITO_ANOS_COMPLETOS'
  END::membresia_motivacao_evento,
  data_demissao,
  igreja_destino,
  data_demissao + interval '1 second',
  updated_at
FROM vinculos_membresia
WHERE data_demissao IS NOT NULL AND modalidade_demissao IS NOT NULL;
SQL
```

Nota: `created_at` do evento de demissão usa `data_demissao + 1s` para garantir que o evento de demissão seja posterior ao de admissão no `ORDER BY created_at`.

- [ ] **Step 4: Verificar migração**

```bash
cd provisao_api
npx prisma db execute --stdin <<'SQL'
SELECT tipo_evento, count(*) as total
FROM eventos_membresia
GROUP BY tipo_evento;
SQL
```

Expected: O total de ADMISSAO deve bater com o total de registros em `vinculos_membresia`. O total de DEMISSAO deve bater com a contagem de registros que tinham `data_demissao`.

- [ ] **Step 5: Commit**

```bash
git commit --allow-empty -m "data: migrate vinculos_membresia to eventos_membresia

SQL migration executed: each vinculos_membresia row became an ADMISSAO
event, rows with data_demissao also got a DEMISSAO event.
Old BATISMO mapped to ADM_BATISMO_NA_INFANCIA (NAO_COMUNGANTES) or
ADM_PROFISSAO_DE_FE_E_BATISMO (COMUNGANTES)."
```

---

### Task 4: Frontend — Tipos, API, Página e Permissões

**Files:**
- Modify: `provisao_frontend/src/types/enums.ts`
- Modify: `provisao_frontend/src/types/models.ts`
- Create: `provisao_frontend/src/api/eventos-membresia.ts`
- Create: `provisao_frontend/src/pages/membresia/GestaoMembresiaPage.tsx`
- Modify: `provisao_frontend/src/lib/permissions.ts`
- Modify: `provisao_frontend/src/App.tsx`
- Modify: `provisao_frontend/src/components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /eventos-membresia` do backend (Task 2), `GET /pessoas` (existente)
- Produces: Página funcional em `/gestao-membresia` com 3 modais

- [ ] **Step 1: Adicionar novos enums em enums.ts**

Adicionar ao final do arquivo (após `ModalidadeDemissao`, que será removido na Task 5):

```typescript
export enum TipoEvento {
  ADMISSAO = "ADMISSAO",
  DEMISSAO = "DEMISSAO",
  MUDANCA_DE_ROL = "MUDANCA_DE_ROL",
}

export enum MembresiaRol {
  COMUNGANTES = "COMUNGANTES",
  NAO_COMUNGANTES = "NAO_COMUNGANTES",
  ROL_SEPARADO = "ROL_SEPARADO",
  EXCLUIDOS = "EXCLUIDOS",
}

export enum MotivacaoEvento {
  ADM_PROFISSAO_DE_FE = "ADM_PROFISSAO_DE_FE",
  ADM_PROFISSAO_DE_FE_E_BATISMO = "ADM_PROFISSAO_DE_FE_E_BATISMO",
  ADM_CARTA_DE_TRANSFERENCIA = "ADM_CARTA_DE_TRANSFERENCIA",
  ADM_JURISDICAO_A_PEDIDO = "ADM_JURISDICAO_A_PEDIDO",
  ADM_JURISDICAO_EX_OFFICIO = "ADM_JURISDICAO_EX_OFFICIO",
  ADM_RESTAURACAO = "ADM_RESTAURACAO",
  ADM_DESIGNACAO_PRESBITERIO = "ADM_DESIGNACAO_PRESBITERIO",
  ADM_BATISMO_NA_INFANCIA = "ADM_BATISMO_NA_INFANCIA",
  ADM_TRANSFERENCIA_PAIS_OU_RESPONSAVEIS = "ADM_TRANSFERENCIA_PAIS_OU_RESPONSAVEIS",
  ADM_JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS = "ADM_JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS",
  DEM_EXCLUSAO_POR_DISCIPLINA = "DEM_EXCLUSAO_POR_DISCIPLINA",
  DEM_EXCLUSAO_A_PEDIDO = "DEM_EXCLUSAO_A_PEDIDO",
  DEM_EXCLUSAO_POR_AUSENCIA = "DEM_EXCLUSAO_POR_AUSENCIA",
  DEM_CARTA_DE_TRANSFERENCIA = "DEM_CARTA_DE_TRANSFERENCIA",
  DEM_JURISDICAO_ASSUMIDA = "DEM_JURISDICAO_ASSUMIDA",
  DEM_FALECIMENTO = "DEM_FALECIMENTO",
  DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS = "DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS",
  DEM_DEZOITO_ANOS_COMPLETOS = "DEM_DEZOITO_ANOS_COMPLETOS",
  DEM_SOLICITACAO_PAIS_OUTRA_COMUNIDADE = "DEM_SOLICITACAO_PAIS_OUTRA_COMUNIDADE",
  OUT_PARADEIRO_IGNORADO = "OUT_PARADEIRO_IGNORADO",
}
```

- [ ] **Step 2: Adicionar interface EventoMembresia em models.ts**

Adicionar ao final do arquivo (manter `VinculoMembresia` até a Task 5):

```typescript
import {
  /* ...existing imports... */
  TipoEvento, MembresiaRol, MotivacaoEvento,
} from "./enums"

export interface EventoMembresia {
  id: string
  igreja_id: string
  pessoa_id: string
  tipo_evento: TipoEvento
  rol: MembresiaRol
  rol_origem: MembresiaRol | null
  motivacao_evento: MotivacaoEvento
  data_evento: string
  igreja_origem: string | null
  igreja_destino: string | null
  observacoes: string | null
  created_at: string
  updated_at: string
  pessoas?: Pessoa
}
```

- [ ] **Step 3: Criar API client**

Create `provisao_frontend/src/api/eventos-membresia.ts`:

```typescript
import { apiClient } from "./client"
import type { EventoMembresia } from "../types/models"

export const eventosMembresiaApi = {
  list: () => apiClient.get<EventoMembresia[]>("eventos-membresia"),
  get: (id: string) => apiClient.get<EventoMembresia>(`eventos-membresia/${id}`),
  getByPessoa: (pessoaId: string) => apiClient.get<EventoMembresia[]>(`eventos-membresia/pessoa/${pessoaId}`),
  create: (data: Partial<EventoMembresia>) => apiClient.post<EventoMembresia>("eventos-membresia", data),
  update: (id: string, data: Partial<EventoMembresia>) => apiClient.patch<EventoMembresia>(`eventos-membresia/${id}`, data),
  remove: (id: string) => apiClient.delete<EventoMembresia>(`eventos-membresia/${id}`),
}
```

- [ ] **Step 4: Atualizar permissões**

In `provisao_frontend/src/lib/permissions.ts`, add `"eventos-membresia"` to the `Module` type and add its permission entries (same permissions as `"vinculos-membresia"`):

```typescript
// In the Module type union, add:
| "eventos-membresia"

// In the PERMISSION_MATRIX, add:
"eventos-membresia": {
  ADMINISTRADOR: ["view"],
  AUDITOR: ["view"],
  OPERADOR: ["view"],
  SECRETARIO: ["view", "create", "edit", "delete"],
  TESOUREIRO: ["view"],
  GESTOR: ["view", "create", "edit"],
},
```

- [ ] **Step 5: Criar a página GestaoMembresiaPage**

Create `provisao_frontend/src/pages/membresia/GestaoMembresiaPage.tsx`:

```tsx
import { useState, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Plus, UserPlus, UserMinus, ArrowLeftRight, Pencil, Trash2, History } from "lucide-react"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { Label } from "../../components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../../components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../../components/ui/select"
import { Textarea } from "../../components/ui/textarea"
import { DataTable, type Column } from "../../components/shared/DataTable"
import { DeleteDialog } from "../../components/shared/DeleteDialog"
import { EmptyState } from "../../components/shared/EmptyState"
import { ErrorState } from "../../components/shared/ErrorState"
import { Badge } from "../../components/ui/badge"
import { usePermissions } from "../../hooks/use-permissions"
import { toast } from "../../components/ui/use-toast"
import { eventosMembresiaApi } from "../../api/eventos-membresia"
import { pessoasApi } from "../../api/pessoas"
import { ApiRequestError } from "../../api/client"
import { TipoEvento, MembresiaRol, MotivacaoEvento } from "../../types/enums"
import type { EventoMembresia } from "../../types/models"

const ROL_LABELS: Record<MembresiaRol, string> = {
  [MembresiaRol.COMUNGANTES]: "Comungantes",
  [MembresiaRol.NAO_COMUNGANTES]: "Não Comungantes",
  [MembresiaRol.ROL_SEPARADO]: "Rol Separado",
  [MembresiaRol.EXCLUIDOS]: "Excluídos",
}

const TIPO_LABELS: Record<TipoEvento, string> = {
  [TipoEvento.ADMISSAO]: "Admissão",
  [TipoEvento.DEMISSAO]: "Demissão",
  [TipoEvento.MUDANCA_DE_ROL]: "Mudança de Rol",
}

const TIPO_VARIANTS: Record<TipoEvento, "success" | "destructive" | "secondary"> = {
  [TipoEvento.ADMISSAO]: "success",
  [TipoEvento.DEMISSAO]: "destructive",
  [TipoEvento.MUDANCA_DE_ROL]: "secondary",
}

const MOTIVACAO_LABELS: Record<MotivacaoEvento, string> = {
  [MotivacaoEvento.ADM_PROFISSAO_DE_FE]: "Profissão de Fé",
  [MotivacaoEvento.ADM_PROFISSAO_DE_FE_E_BATISMO]: "Profissão de Fé e Batismo",
  [MotivacaoEvento.ADM_CARTA_DE_TRANSFERENCIA]: "Carta de Transferência",
  [MotivacaoEvento.ADM_JURISDICAO_A_PEDIDO]: "Jurisdição a Pedido",
  [MotivacaoEvento.ADM_JURISDICAO_EX_OFFICIO]: "Jurisdição Ex Officio",
  [MotivacaoEvento.ADM_RESTAURACAO]: "Restauração",
  [MotivacaoEvento.ADM_DESIGNACAO_PRESBITERIO]: "Designação do Presbitério",
  [MotivacaoEvento.ADM_BATISMO_NA_INFANCIA]: "Batismo na Infância",
  [MotivacaoEvento.ADM_TRANSFERENCIA_PAIS_OU_RESPONSAVEIS]: "Transferência dos Pais ou Responsáveis",
  [MotivacaoEvento.ADM_JURISDICAO_ASSUMIDA_SOBRE_PAIS_OU_RESPONSAVEIS]: "Jurisdição Assumida sobre os Pais ou Responsáveis",
  [MotivacaoEvento.DEM_EXCLUSAO_POR_DISCIPLINA]: "Exclusão por Disciplina",
  [MotivacaoEvento.DEM_EXCLUSAO_A_PEDIDO]: "Exclusão a Pedido",
  [MotivacaoEvento.DEM_EXCLUSAO_POR_AUSENCIA]: "Exclusão por Ausência",
  [MotivacaoEvento.DEM_CARTA_DE_TRANSFERENCIA]: "Carta de Transferência",
  [MotivacaoEvento.DEM_JURISDICAO_ASSUMIDA]: "Jurisdição Assumida por Outra Igreja",
  [MotivacaoEvento.DEM_FALECIMENTO]: "Falecimento",
  [MotivacaoEvento.DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS]: "Carta de Transferência dos Pais ou Responsáveis",
  [MotivacaoEvento.DEM_DEZOITO_ANOS_COMPLETOS]: "18 Anos Completos",
  [MotivacaoEvento.DEM_SOLICITACAO_PAIS_OUTRA_COMUNIDADE]: "Solicitação dos Pais (Outra Comunidade)",
  [MotivacaoEvento.OUT_PARADEIRO_IGNORADO]: "Paradeiro Ignorado",
}

const ADM_MOTIVACOES = Object.entries(MOTIVACAO_LABELS).filter(([k]) => k.startsWith("ADM_"))
const DEM_MOTIVACOES = Object.entries(MOTIVACAO_LABELS).filter(([k]) => k.startsWith("DEM_"))
const MUD_MOTIVACOES = Object.entries(MOTIVACAO_LABELS).filter(([k]) => k.startsWith("ADM_") || k.startsWith("OUT_"))

const DEMISSAO_ROL_MAP: Record<string, MembresiaRol> = {
  DEM_EXCLUSAO_POR_DISCIPLINA: MembresiaRol.EXCLUIDOS,
  DEM_EXCLUSAO_A_PEDIDO: MembresiaRol.EXCLUIDOS,
  DEM_EXCLUSAO_POR_AUSENCIA: MembresiaRol.EXCLUIDOS,
  DEM_CARTA_DE_TRANSFERENCIA: MembresiaRol.ROL_SEPARADO,
  DEM_JURISDICAO_ASSUMIDA: MembresiaRol.ROL_SEPARADO,
  DEM_FALECIMENTO: MembresiaRol.ROL_SEPARADO,
  DEM_CARTA_DE_TRANSFERENCIA_DOS_PAIS_OU_RESPONSAVEIS: MembresiaRol.ROL_SEPARADO,
  DEM_DEZOITO_ANOS_COMPLETOS: MembresiaRol.ROL_SEPARADO,
  DEM_SOLICITACAO_PAIS_OUTRA_COMUNIDADE: MembresiaRol.ROL_SEPARADO,
}

const admissaoSchema = z.object({
  pessoa_id: z.string().uuid("Pessoa é obrigatória"),
  rol: z.nativeEnum(MembresiaRol),
  motivacao_evento: z.nativeEnum(MotivacaoEvento),
  data_evento: z.string().min(1, "Data é obrigatória"),
  igreja_origem: z.string().optional().or(z.literal("")),
  observacoes: z.string().optional().or(z.literal("")),
})

const demissaoSchema = z.object({
  pessoa_id: z.string().uuid("Pessoa é obrigatória"),
  motivacao_evento: z.nativeEnum(MotivacaoEvento),
  data_evento: z.string().min(1, "Data é obrigatória"),
  igreja_destino: z.string().optional().or(z.literal("")),
  observacoes: z.string().optional().or(z.literal("")),
})

const mudancaRolSchema = z.object({
  pessoa_id: z.string().uuid("Pessoa é obrigatória"),
  rol: z.nativeEnum(MembresiaRol),
  motivacao_evento: z.nativeEnum(MotivacaoEvento),
  data_evento: z.string().min(1, "Data é obrigatória"),
  observacoes: z.string().optional().or(z.literal("")),
})

type ModalType = "admissao" | "demissao" | "mudanca" | null

export function GestaoMembresiaPage() {
  const [modal, setModal] = useState<ModalType>(null)
  const [editing, setEditing] = useState<EventoMembresia | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<EventoMembresia | null>(null)
  const { canCreate, canEdit, canDelete } = usePermissions("eventos-membresia")
  const queryClient = useQueryClient()

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["eventos-membresia"],
    queryFn: eventosMembresiaApi.list,
  })
  const { data: pessoas } = useQuery({ queryKey: ["pessoas"], queryFn: pessoasApi.list })

  const lastEventIds = useMemo(() => {
    if (!data) return new Set<string>()
    const seen = new Set<string>()
    const ids = new Set<string>()
    for (const ev of data) {
      if (!seen.has(ev.pessoa_id)) {
        seen.add(ev.pessoa_id)
        ids.add(ev.id)
      }
    }
    return ids
  }, [data])

  const admForm = useForm({ resolver: zodResolver(admissaoSchema), defaultValues: { pessoa_id: "", rol: MembresiaRol.COMUNGANTES, motivacao_evento: "" as MotivacaoEvento, data_evento: "", igreja_origem: "", observacoes: "" } })
  const demForm = useForm({ resolver: zodResolver(demissaoSchema), defaultValues: { pessoa_id: "", motivacao_evento: "" as MotivacaoEvento, data_evento: "", igreja_destino: "", observacoes: "" } })
  const mudForm = useForm({ resolver: zodResolver(mudancaRolSchema), defaultValues: { pessoa_id: "", rol: MembresiaRol.COMUNGANTES, motivacao_evento: "" as MotivacaoEvento, data_evento: "", observacoes: "" } })

  const [rolOrigem, setRolOrigem] = useState<string>("")

  const createMut = useMutation({
    mutationFn: (d: Partial<EventoMembresia>) => eventosMembresiaApi.create(d),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["eventos-membresia"] }); toast({ title: "Evento registrado com sucesso" }); closeModal() },
    onError: (e) => toast({ title: "Erro", description: e instanceof ApiRequestError ? e.messages[0] : "Erro ao registrar", variant: "destructive" }),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, d }: { id: string; d: Partial<EventoMembresia> }) => eventosMembresiaApi.update(id, d),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["eventos-membresia"] }); toast({ title: "Evento atualizado" }); closeModal() },
    onError: (e) => toast({ title: "Erro", description: e instanceof ApiRequestError ? e.messages[0] : "Erro ao atualizar", variant: "destructive" }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => eventosMembresiaApi.remove(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["eventos-membresia"] }); toast({ title: "Evento excluído" }); setDeleteTarget(null) },
    onError: (e) => toast({ title: "Erro", description: e instanceof ApiRequestError ? e.messages[0] : "Erro ao excluir", variant: "destructive" }),
  })

  function closeModal() { setModal(null); setEditing(null); setRolOrigem(""); admForm.reset(); demForm.reset(); mudForm.reset() }

  function openEdit(item: EventoMembresia) {
    setEditing(item)
    if (item.tipo_evento === TipoEvento.ADMISSAO) {
      admForm.reset({ pessoa_id: item.pessoa_id, rol: item.rol as MembresiaRol, motivacao_evento: item.motivacao_evento as MotivacaoEvento, data_evento: item.data_evento.split("T")[0], igreja_origem: item.igreja_origem ?? "", observacoes: item.observacoes ?? "" })
      setModal("admissao")
    } else if (item.tipo_evento === TipoEvento.DEMISSAO) {
      demForm.reset({ pessoa_id: item.pessoa_id, motivacao_evento: item.motivacao_evento as MotivacaoEvento, data_evento: item.data_evento.split("T")[0], igreja_destino: item.igreja_destino ?? "", observacoes: item.observacoes ?? "" })
      setModal("demissao")
    } else {
      setRolOrigem(item.rol_origem ? ROL_LABELS[item.rol_origem as MembresiaRol] : "")
      mudForm.reset({ pessoa_id: item.pessoa_id, rol: item.rol as MembresiaRol, motivacao_evento: item.motivacao_evento as MotivacaoEvento, data_evento: item.data_evento.split("T")[0], observacoes: item.observacoes ?? "" })
      setModal("mudanca")
    }
  }

  function onSubmitAdmissao(d: z.infer<typeof admissaoSchema>) {
    const payload: any = { ...d, tipo_evento: TipoEvento.ADMISSAO, igreja_origem: d.igreja_origem || undefined, observacoes: d.observacoes || undefined }
    if (editing) updateMut.mutate({ id: editing.id, d: payload })
    else createMut.mutate(payload)
  }

  function onSubmitDemissao(d: z.infer<typeof demissaoSchema>) {
    const rol = DEMISSAO_ROL_MAP[d.motivacao_evento] ?? MembresiaRol.ROL_SEPARADO
    const payload: any = { ...d, tipo_evento: TipoEvento.DEMISSAO, rol, igreja_destino: d.igreja_destino || undefined, observacoes: d.observacoes || undefined }
    if (editing) updateMut.mutate({ id: editing.id, d: payload })
    else createMut.mutate(payload)
  }

  function onSubmitMudanca(d: z.infer<typeof mudancaRolSchema>) {
    const payload: any = { ...d, tipo_evento: TipoEvento.MUDANCA_DE_ROL, observacoes: d.observacoes || undefined }
    if (editing) updateMut.mutate({ id: editing.id, d: payload })
    else createMut.mutate(payload)
  }

  function handleMudancaPessoaChange(pessoaId: string) {
    mudForm.setValue("pessoa_id", pessoaId)
    const lastEvent = data?.find((ev) => ev.pessoa_id === pessoaId)
    setRolOrigem(lastEvent ? ROL_LABELS[lastEvent.rol as MembresiaRol] ?? "" : "Sem registro anterior")
  }

  const columns: Column<EventoMembresia>[] = [
    { key: "pessoa", header: "Pessoa", render: (v) => <span>{v.pessoas?.nome_completo ?? v.pessoa_id.slice(0, 8)}</span>, sortable: true },
    { key: "tipo_evento", header: "Tipo", render: (v) => <Badge variant={TIPO_VARIANTS[v.tipo_evento]}>{TIPO_LABELS[v.tipo_evento]}</Badge> },
    { key: "rol", header: "Rol", render: (v) => <Badge variant="outline">{ROL_LABELS[v.rol as MembresiaRol]}</Badge> },
    { key: "motivacao_evento", header: "Motivação", render: (v) => <span className="text-sm">{MOTIVACAO_LABELS[v.motivacao_evento as MotivacaoEvento]}</span> },
    { key: "data_evento", header: "Data", render: (v) => <span className="text-sm">{new Date(v.data_evento).toLocaleDateString("pt-BR")}</span> },
  ]

  const isPending = createMut.isPending || updateMut.isPending
  const mudRolOptions = Object.entries(ROL_LABELS).filter(([k]) => k !== MembresiaRol.EXCLUIDOS)

  const actions = (canEdit || canDelete)
    ? (item: EventoMembresia) => {
        const isLast = lastEventIds.has(item.id)
        if (!isLast) return null
        return (
          <div className="flex gap-1">
            {canEdit && <Button variant="ghost" size="icon" onClick={() => openEdit(item)}><Pencil size={16} /></Button>}
            {canDelete && <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(item)}><Trash2 size={16} className="text-destructive" /></Button>}
          </div>
        )
      }
    : undefined

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-heading font-bold">Gestão de Membresia</h2>
          <p className="text-sm text-muted-foreground">Registre e acompanhe eventos de admissão, demissão e mudança de rol</p>
        </div>
        {canCreate && (
          <div className="flex gap-2">
            <Button variant="default" onClick={() => { admForm.reset(); setModal("admissao") }}><UserPlus size={18} className="mr-2" />Admitir</Button>
            <Button variant="destructive" onClick={() => { demForm.reset(); setModal("demissao") }}><UserMinus size={18} className="mr-2" />Demitir</Button>
            <Button variant="secondary" onClick={() => { mudForm.reset(); setRolOrigem(""); setModal("mudanca") }}><ArrowLeftRight size={18} className="mr-2" />Mudar Rol</Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Carregando...</div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : !data?.length ? (
        <EmptyState icon={History} title="Nenhum evento" description="Nenhum evento de membresia registrado" />
      ) : (
        <DataTable data={data} columns={columns} keyExtractor={(v) => v.id} actions={actions} />
      )}

      {/* Modal de Admissão */}
      <Dialog open={modal === "admissao"} onOpenChange={(o) => !o && closeModal()}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? "Editar" : "Nova"} Admissão</DialogTitle></DialogHeader>
          <form onSubmit={admForm.handleSubmit(onSubmitAdmissao)} className="space-y-4">
            <div className="space-y-2">
              <Label>Pessoa *</Label>
              <Select value={admForm.watch("pessoa_id")} onValueChange={(v) => admForm.setValue("pessoa_id", v)}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{pessoas?.map((p) => <SelectItem key={p.id} value={p.id}>{p.nome_completo}</SelectItem>)}</SelectContent>
              </Select>
              {admForm.formState.errors.pessoa_id && <p className="text-xs text-destructive">{admForm.formState.errors.pessoa_id.message}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Rol *</Label>
                <Select value={admForm.watch("rol")} onValueChange={(v) => admForm.setValue("rol", v as MembresiaRol)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MembresiaRol.COMUNGANTES}>Comungantes</SelectItem>
                    <SelectItem value={MembresiaRol.NAO_COMUNGANTES}>Não Comungantes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Motivação *</Label>
                <Select value={admForm.watch("motivacao_evento")} onValueChange={(v) => admForm.setValue("motivacao_evento", v as MotivacaoEvento)}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>{ADM_MOTIVACOES.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="adm_data">Data de Admissão *</Label>
                <Input id="adm_data" type="date" {...admForm.register("data_evento")} />
                {admForm.formState.errors.data_evento && <p className="text-xs text-destructive">{admForm.formState.errors.data_evento.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="adm_origem">Igreja de Origem</Label>
                <Input id="adm_origem" {...admForm.register("igreja_origem")} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="adm_obs">Observações</Label>
              <Textarea id="adm_obs" rows={2} {...admForm.register("observacoes")} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeModal}>Cancelar</Button>
              <Button type="submit" disabled={isPending}>{isPending ? "Salvando..." : "Salvar"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Modal de Demissão */}
      <Dialog open={modal === "demissao"} onOpenChange={(o) => !o && closeModal()}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? "Editar" : "Nova"} Demissão</DialogTitle></DialogHeader>
          <form onSubmit={demForm.handleSubmit(onSubmitDemissao)} className="space-y-4">
            <div className="space-y-2">
              <Label>Pessoa *</Label>
              <Select value={demForm.watch("pessoa_id")} onValueChange={(v) => demForm.setValue("pessoa_id", v)}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{pessoas?.map((p) => <SelectItem key={p.id} value={p.id}>{p.nome_completo}</SelectItem>)}</SelectContent>
              </Select>
              {demForm.formState.errors.pessoa_id && <p className="text-xs text-destructive">{demForm.formState.errors.pessoa_id.message}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dem_data">Data de Demissão *</Label>
                <Input id="dem_data" type="date" {...demForm.register("data_evento")} />
                {demForm.formState.errors.data_evento && <p className="text-xs text-destructive">{demForm.formState.errors.data_evento.message}</p>}
              </div>
              <div className="space-y-2">
                <Label>Motivação *</Label>
                <Select value={demForm.watch("motivacao_evento")} onValueChange={(v) => demForm.setValue("motivacao_evento", v as MotivacaoEvento)}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>{DEM_MOTIVACOES.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dem_destino">Igreja de Destino</Label>
              <Input id="dem_destino" {...demForm.register("igreja_destino")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dem_obs">Observações</Label>
              <Textarea id="dem_obs" rows={2} {...demForm.register("observacoes")} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeModal}>Cancelar</Button>
              <Button type="submit" variant="destructive" disabled={isPending}>{isPending ? "Salvando..." : "Confirmar Demissão"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Modal de Mudança de Rol */}
      <Dialog open={modal === "mudanca"} onOpenChange={(o) => !o && closeModal()}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? "Editar" : "Nova"} Mudança de Rol</DialogTitle></DialogHeader>
          <form onSubmit={mudForm.handleSubmit(onSubmitMudanca)} className="space-y-4">
            <div className="space-y-2">
              <Label>Pessoa *</Label>
              <Select value={mudForm.watch("pessoa_id")} onValueChange={handleMudancaPessoaChange}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{pessoas?.map((p) => <SelectItem key={p.id} value={p.id}>{p.nome_completo}</SelectItem>)}</SelectContent>
              </Select>
              {mudForm.formState.errors.pessoa_id && <p className="text-xs text-destructive">{mudForm.formState.errors.pessoa_id.message}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Rol de Origem</Label>
                <Input value={rolOrigem} disabled className="bg-muted" />
              </div>
              <div className="space-y-2">
                <Label>Novo Rol *</Label>
                <Select value={mudForm.watch("rol")} onValueChange={(v) => mudForm.setValue("rol", v as MembresiaRol)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{mudRolOptions.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Motivação *</Label>
                <Select value={mudForm.watch("motivacao_evento")} onValueChange={(v) => mudForm.setValue("motivacao_evento", v as MotivacaoEvento)}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>{MUD_MOTIVACOES.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mud_data">Data *</Label>
                <Input id="mud_data" type="date" {...mudForm.register("data_evento")} />
                {mudForm.formState.errors.data_evento && <p className="text-xs text-destructive">{mudForm.formState.errors.data_evento.message}</p>}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mud_obs">Observações</Label>
              <Textarea id="mud_obs" rows={2} {...mudForm.register("observacoes")} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeModal}>Cancelar</Button>
              <Button type="submit" disabled={isPending}>{isPending ? "Salvando..." : "Salvar"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        loading={deleteMut.isPending}
        title="Excluir evento"
        description="Tem certeza que deseja excluir este evento de membresia? Esta ação não pode ser desfeita."
      />
    </div>
  )
}
```

- [ ] **Step 6: Atualizar rota em App.tsx**

Substituir a rota existente de vinculos-membresia:

```tsx
// Remover:
<Route path="vinculos-membresia" element={<VinculosPage />} />

// Adicionar:
<Route path="gestao-membresia" element={<GestaoMembresiaPage />} />
```

Adicionar o import:
```tsx
import { GestaoMembresiaPage } from "./pages/membresia/GestaoMembresiaPage"
```

Remover o import de `VinculosPage`.

- [ ] **Step 7: Atualizar Sidebar.tsx**

Substituir o item de menu:

```typescript
// Remover:
{ kind: "item", path: "/vinculos-membresia", icon: Link2, label: "Vinculos de Membresia", modules: ["vinculos-membresia"] },

// Adicionar:
{ kind: "item", path: "/gestao-membresia", icon: History, label: "Gestão de Membresia", modules: ["eventos-membresia"] },
```

Atualizar o import de ícones: adicionar `History` de `lucide-react`, remover `Link2` se não for usado em outro lugar.

- [ ] **Step 8: Verificar compilação do frontend**

```bash
cd provisao_frontend
npx tsc --noEmit
```

Expected: No errors (os tipos antigos ainda existem, não há conflito).

- [ ] **Step 9: Testar no navegador**

```bash
cd provisao_frontend
npm run dev
```

Navegar até `/gestao-membresia` e verificar:
1. Tabela exibe eventos migrados
2. Botão "Admitir" abre modal com campos corretos
3. Botão "Demitir" abre modal com campos corretos
4. Botão "Mudar Rol" abre modal com autopreenchimento de Rol de Origem
5. Editar/Excluir só aparece no último evento de cada pessoa
6. Criar novo evento funciona

- [ ] **Step 10: Commit**

```bash
git add provisao_frontend/src/types/enums.ts \
       provisao_frontend/src/types/models.ts \
       provisao_frontend/src/api/eventos-membresia.ts \
       provisao_frontend/src/pages/membresia/GestaoMembresiaPage.tsx \
       provisao_frontend/src/lib/permissions.ts \
       provisao_frontend/src/App.tsx \
       provisao_frontend/src/components/layout/Sidebar.tsx
git commit -m "feat(frontend): add GestaoMembresiaPage with 3 modal forms

New event-sourced membership page with:
- Admitir/Demitir/Mudar Rol action buttons
- Dynamic modal forms per event type
- Prefix-filtered motivacao selects (ADM_/DEM_/OUT_)
- Auto rol_origem for MUDANCA_DE_ROL
- Auto rol assignment for DEMISSAO
- Last-event-only edit/delete restriction
- Route: /gestao-membresia"
```

---

### Task 5: Cleanup — Remover código antigo e enums obsoletos

**Files:**
- Delete: `provisao_api/src/vinculos-membresia/` (diretório inteiro)
- Delete: `provisao_frontend/src/pages/configuracoes/VinculosPage.tsx`
- Delete: `provisao_frontend/src/api/vinculos-membresia.ts`
- Modify: `provisao_api/prisma/schema.prisma` — remover modelo e enums antigos
- Modify: `provisao_api/src/app.module.ts` — remover VinculosMembresiaModule
- Modify: `provisao_frontend/src/types/enums.ts` — remover enums antigos
- Modify: `provisao_frontend/src/types/models.ts` — remover VinculoMembresia interface
- Modify: `provisao_frontend/src/lib/permissions.ts` — remover módulo antigo

**Interfaces:**
- Consumes: Tudo funcionando na Task 4
- Produces: Codebase limpo sem referências a vinculos_membresia

- [ ] **Step 1: Remover módulo backend antigo**

```bash
rm -rf provisao_api/src/vinculos-membresia/
```

In `provisao_api/src/app.module.ts`, remover:
```typescript
// Remover o import:
import { VinculosMembresiaModule } from './vinculos-membresia/vinculos-membresia.module';

// Remover VinculosMembresiaModule do array imports
```

- [ ] **Step 2: Remover modelo e enums antigos do schema.prisma**

Remover do `provisao_api/prisma/schema.prisma`:

```prisma
// Remover inteiramente:
model vinculos_membresia { ... }
enum vinculos_membresia_rol { ... }
enum vinculos_membresia_forma_admissao { ... }
enum vinculos_membresia_modalidade_demissao { ... }
```

Remover as linhas de relação reversa nos modelos `igreja` e `pessoas`:
```prisma
// Em igreja, remover:
  vinculos_membresia vinculos_membresia[]

// Em pessoas, remover:
  vinculos_membresia vinculos_membresia[]
```

- [ ] **Step 3: Executar prisma db push para dropar tabela e enums antigos**

```bash
cd provisao_api
npx prisma db push --accept-data-loss
```

O flag `--accept-data-loss` é necessário porque estamos removendo a tabela `vinculos_membresia` (os dados já foram migrados na Task 3).

- [ ] **Step 4: Remover arquivos frontend antigos**

```bash
rm provisao_frontend/src/pages/configuracoes/VinculosPage.tsx
rm provisao_frontend/src/api/vinculos-membresia.ts
```

- [ ] **Step 5: Remover enums e tipos antigos do frontend**

Em `provisao_frontend/src/types/enums.ts`, remover:
```typescript
// Remover inteiramente:
export enum VinculoRol { ... }
export enum FormaAdmissao { ... }
export enum ModalidadeDemissao { ... }
```

Em `provisao_frontend/src/types/models.ts`, remover:
```typescript
// Remover inteiramente:
export interface VinculoMembresia { ... }

// Remover imports antigos (VinculoRol, FormaAdmissao, ModalidadeDemissao)
// Manter imports novos (TipoEvento, MembresiaRol, MotivacaoEvento)
```

Na interface `Pessoa`, atualizar a relação:
```typescript
// Remover:
  vinculos_membresia?: VinculoMembresia[]
// Adicionar:
  eventos_membresia?: EventoMembresia[]
```

- [ ] **Step 6: Remover módulo antigo das permissões**

Em `provisao_frontend/src/lib/permissions.ts`:
```typescript
// Remover "vinculos-membresia" do type Module e do PERMISSION_MATRIX
```

- [ ] **Step 7: Verificar que não restam referências**

```bash
grep -r "vinculos.membresia\|VinculoMembresia\|VinculoRol\|FormaAdmissao\|ModalidadeDemissao\|VinculosPage" \
  provisao_api/src/ provisao_frontend/src/ \
  --include="*.ts" --include="*.tsx" -l
```

Expected: Nenhum resultado (zero referências restantes).

- [ ] **Step 8: Verificar compilação de ambos os projetos**

```bash
cd provisao_api && npx tsc --noEmit
cd ../provisao_frontend && npx tsc --noEmit
```

Expected: Zero errors em ambos.

- [ ] **Step 9: Executar testes**

```bash
cd provisao_api
npx jest --verbose
```

Expected: All tests pass (incluindo os novos testes da Task 2).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: remove vinculos_membresia module, enums and table

Cleanup after migration to event-sourced eventos_membresia.
Dropped: vinculos_membresia table, 3 old enums, backend module,
frontend page, API client, permission entries.
All data was migrated in the previous commit."
```
