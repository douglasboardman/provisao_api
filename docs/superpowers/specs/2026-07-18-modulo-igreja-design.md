# Design: Módulo Igreja

**Data:** 2026-07-18
**Escopo:** `provisao_api`

---

## Contexto

`igreja` é a âncora multi-tenant da aplicação. Todo recurso (pessoas, contas, lançamentos, etc.) é isolado por `igreja_id`, extraído do JWT. O módulo expõe CRUD parcial: criação reservada a superadmin externo via API key; leitura e edição disponíveis ao usuário autenticado para a própria igreja.

---

## Arquitetura

### Arquivos novos
| Arquivo | Responsabilidade |
|---|---|
| `src/igreja/igreja.module.ts` | Declara e wires o módulo |
| `src/igreja/igreja.controller.ts` | Roteamento e guards |
| `src/igreja/igreja.service.ts` | Lógica de negócio |
| `src/igreja/dto/create-igreja.dto.ts` | Schema Zod + classe DTO para criação |
| `src/igreja/dto/update-igreja.dto.ts` | Partial do schema de criação |
| `src/igreja/guards/admin-key.guard.ts` | Valida `X-Admin-Key` header |

### Arquivos modificados
| Arquivo | Alteração |
|---|---|
| `src/app.module.ts` | Adicionar `IgrejaModule` aos imports |

---

## Endpoints

| Método | Rota | Guard | Perfis permitidos |
|---|---|---|---|
| `POST` | `/igrejas` | `AdminKeyGuard` | — (sem JWT) |
| `GET` | `/igrejas/me` | `AuthGuard` + `RolesGuard` | todos |
| `PATCH` | `/igrejas/me` | `AuthGuard` + `RolesGuard` | ADMINISTRADOR |
| `PATCH` | `/igrejas/me/logo` | `AuthGuard` + `RolesGuard` | ADMINISTRADOR |
| `GET` | `/igrejas/me/congregacoes` | `AuthGuard` + `RolesGuard` | todos |

---

## AdminKeyGuard

Arquivo: `src/igreja/guards/admin-key.guard.ts`

- Lê header `X-Admin-Key` da requisição
- Compara com `process.env.ADMIN_KEY` via `ConfigService`
- Se `ADMIN_KEY` não estiver definida no `.env` → nega tudo (fail-closed)
- Retorna `403 ForbiddenException` se a chave não bater

---

## DTOs

### `CreateIgrejaDto`

```ts
z.object({
  nome: z.string().min(1),
  cnpj: z.string().length(14).regex(/^\d{14}$/).optional(),
  congregacao: z.boolean().default(false),
  vinculada_a: z.string().uuid().optional(),
  cep: z.string().length(8).regex(/^\d{8}$/).optional(),
  logradouro: z.string().optional(),
  numero: z.string().optional(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
  cidade: z.string().optional(),
  estado: z.nativeEnum(estados_brasil).optional(),
})
```

### `UpdateIgrejaDto`

Partial do `CreateIgrejaSchema`, omitindo `congregacao` e `vinculada_a` (tipo e vínculo de matriz não mudam após criação).

---

## IgrejaService

### `create(dto: CreateIgrejaDto): Promise<igreja>`
- Se `dto.vinculada_a` fornecido: valida que a matriz existe (`findUnique`); lança `NotFoundException` se não existir
- Se `dto.cnpj` fornecido: valida unicidade global (CNPJ não é por-tenant); lança `ConflictException` se já cadastrado
- Cria e retorna o registro

### `findMe(igreja_id: string): Promise<igreja>`
- `prisma.igreja.findUnique({ where: { id: igreja_id } })`
- Lança `NotFoundException` se não encontrada

### `updateMe(igreja_id: string, dto: UpdateIgrejaDto): Promise<igreja>`
- Se `dto.cnpj` fornecido: valida unicidade global excluindo a própria igreja
- Atualiza e retorna o registro

### `updateLogo(igreja_id: string, file: Express.Multer.File): Promise<igreja>`
- Chama `StorageService.uploadFile(file, 'church-logos')`
- Atualiza `url_logo` e retorna o registro

### `findCongregacoes(igreja_id: string): Promise<igreja[]>`
- `prisma.igreja.findMany({ where: { vinculada_a: igreja_id } })`

---

## IgrejaModule

```ts
@Module({
  imports: [StorageModule, AuthModule],
  controllers: [IgrejaController],
  providers: [IgrejaService, AdminKeyGuard],
})
export class IgrejaModule {}
```

Segue o padrão dos demais módulos com upload (ex: `UsuariosModule`): importa `StorageModule` e `AuthModule`.

---

## Critérios de sucesso

- `POST /igrejas` com `X-Admin-Key` correto cria a igreja e retorna `201`
- `POST /igrejas` sem a key ou com key errada retorna `403`
- `GET /igrejas/me` retorna dados da igreja do usuário autenticado
- `PATCH /igrejas/me` por não-ADMINISTRADOR retorna `403`
- `PATCH /igrejas/me/logo` salva arquivo em `uploads/church-logos/` e atualiza `url_logo`
- `GET /igrejas/me/congregacoes` retorna lista vazia `[]` para igrejas sem congregações filhas
- CNPJ duplicado em `POST` ou `PATCH` retorna `409`
