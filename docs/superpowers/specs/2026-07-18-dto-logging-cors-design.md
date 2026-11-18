# Design: DTOs Zod + Audit Logging + CORS

**Data:** 2026-07-18
**Escopo:** `provisao_api`

---

## 1. Migração de DTOs para `nestjs-zod`

### Objetivo
Substituir `class-validator` + `class-transformer` por `zod` + `nestjs-zod` em todos os DTOs da API.

### Mudanças de dependências
- Instalar: `nestjs-zod`, `zod`
- Remover: `class-validator`, `class-transformer`

### `main.ts`
Substituir `ValidationPipe` global por `ZodValidationPipe`:
```ts
import { ZodValidationPipe } from 'nestjs-zod';
app.useGlobalPipes(new ZodValidationPipe());
```

### Schema CPF reutilizável
Criar `src/core/schemas/cpf.schema.ts`:
- `z.string().refine()` com validação dos dígitos verificadores do CPF
- Exportado como `CpfSchema` para uso nos DTOs de `pessoas` e qualquer outro módulo com campo CPF

### Padrão de cada módulo

**`create-*.dto.ts`:**
```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateXxxSchema = z.object({ ... });
export class CreateXxxDto extends createZodDto(CreateXxxSchema) {}
```

**`update-*.dto.ts`:**
```ts
import { createZodDto } from 'nestjs-zod';
import { CreateXxxSchema } from './create-xxx.dto';
export class UpdateXxxDto extends createZodDto(CreateXxxSchema.partial()) {}
```

### Módulos cobertos
Todos os DTOs existentes:
- `acoes`, `auth` (sign-in, register, forgot-password, reset-password), `cat-despesa`, `cat-receita`, `contas`, `despesas`, `grupos-familiares`, `lancamentos`, `pessoas`, `receitas`, `usuarios`, `vinculos-membresia`

### Critério de sucesso
`npm run build` sem erros de TypeScript após a migração completa.

---

## 2. Audit Logging Automático

### Objetivo
Registrar automaticamente operações de escrita em `logs_atividades` sem modificar controllers existentes.

### Método `LogsService.registrar(...)`
Novo método no `LogsService` existente:
```ts
async registrar(data: {
  igreja_id: string;
  usuario_id: string;
  acao: logs_atividades_acao;
  entidade_tipo: string;
  entidade_id: string | null;
  detalhes?: object;
}): Promise<void>
```
Escrita fire-and-forget (falha silenciosa — não propaga exceção).

### `AuditInterceptor`
Arquivo: `src/logs/audit.interceptor.ts`

**Regras de filtragem (não loga se):**
- Método HTTP é GET
- Path começa com `/auth`
- `req.user` está ausente (requisição não autenticada)

**Mapeamento HTTP → enum:**
| Método | `acao` |
|--------|--------|
| POST | `CRIACAO` |
| PATCH / PUT | `ATUALIZACAO` |
| DELETE | `EXCLUSAO` |

**Extração de campos:**
- `entidade_tipo`: primeiro segmento do path (ex: `/lancamentos/123` → `"lancamentos"`)
- `entidade_id`: POST → `response?.id`; PATCH/DELETE → `req.params.id`
- `detalhes`: `{ endpoint: req.url, ip: req.ip }`
- `igreja_id` e `usuario_id`: extraídos de `req.user`

**Execução:** `tap()` no observable retornado — escreve após a resposta bem-sucedida, não bloqueia.

### Registro global
No `AppModule`:
```ts
{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }
```
`LogsModule` deve exportar `LogsService` para injeção no interceptor.

### Login events (AuthService)
Fora do interceptor (rota `/auth` é ignorada), o `AuthService` chama `LogsService.registrar()` explicitamente:
- Login bem-sucedido → `LOGIN_SUCESSO`, `entidade_tipo: "auth"`, `entidade_id: usuario.id`
- Credenciais inválidas → `LOGIN_FALHA`, `entidade_tipo: "auth"`, `entidade_id: null`

`AuthModule` deve importar `LogsModule`.

### Critério de sucesso
Após POST/PATCH/DELETE em qualquer rota autenticada, um registro aparece em `logs_atividades`. GET não gera registro.

---

## 3. CORS

### Objetivo
Permitir que o frontend consuma a API sem erros de CORS no browser.

### Mudança em `main.ts`
```ts
const configService = app.get(ConfigService);
app.enableCors({
  origin: configService.get<string>('FRONTEND_URL'),
  credentials: true,
});
```

Posicionado antes de `app.listen()`.

**Variável de ambiente:** `FRONTEND_URL` já existe no `.env` e já é usada pelo `AuthService`. Nenhuma variável nova necessária.

**`credentials: true`:** necessário porque o frontend envia JWT no header `Authorization`.

### Critério de sucesso
Requests do frontend em `FRONTEND_URL` não são bloqueados pelo browser com erro de CORS.
