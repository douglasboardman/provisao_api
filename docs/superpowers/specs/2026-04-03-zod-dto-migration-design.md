# Design: Migração de DTOs para Zod (nestjs-zod)

**Data:** 2026-04-03
**Escopo:** Todos os módulos da `provisao_api`

---

## 1. Objetivo

Substituir `class-validator` + `class-transformer` por `zod` + `nestjs-zod` em todos os DTOs da API, mantendo a estrutura de arquivos existente e garantindo validação de entrada tipada e expressiva.

---

## 2. Instalação e Configuração Global

### Pacotes

```bash
npm install nestjs-zod zod
npm uninstall class-validator class-transformer
```

### `main.ts`

Registrar o `ZodValidationPipe` globalmente, substituindo qualquer `ValidationPipe` existente:

```ts
import { ZodValidationPipe } from 'nestjs-zod';
app.useGlobalPipes(new ZodValidationPipe());
```

---

## 3. Padrão de Estrutura dos DTOs

Schema e DTO ficam no mesmo arquivo. Update DTOs usam `.partial()` do Zod.

### `create-*.dto.ts`

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const CreateXxxSchema = z.object({ ... });

export class CreateXxxDto extends createZodDto(CreateXxxSchema) {}
```

### `update-*.dto.ts`

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { CreateXxxSchema } from './create-xxx.dto';

const UpdateXxxSchema = CreateXxxSchema.partial();

export class UpdateXxxDto extends createZodDto(UpdateXxxSchema) {}
```

> **Nota:** O schema `CreateXxxSchema` deve ser exportado do arquivo de criação para ser reutilizado no update.

---

## 4. Schema de CPF Reutilizável

**Arquivo:** `src/core/schemas/cpf.schema.ts`

Extraído do `@IsCpf()` decorator existente em `src/core/decorators/is-cpf.decorator.ts`. A lógica de validação do CPF é mantida idêntica, apenas encapsulada como refinement Zod.

```ts
import { z } from 'zod';

function isCpfValid(cpf: string): boolean {
  // mesma lógica do is-cpf.decorator.ts
}

export const CpfSchema = z.string()
  .length(11, { message: 'O CPF deve ter exatamente 11 dígitos.' })
  .refine(isCpfValid, { message: 'O CPF informado é inválido.' });
```

---

## 5. Mapeamento de Conversões por Módulo

### 5.1 `acoes`

| Campo | class-validator | Zod |
|---|---|---|
| `nome` | `@IsString @IsNotEmpty` | `z.string().min(1)` |
| `descricao_detalhada` | `@IsOptional @IsString` | `z.string().optional()` |
| `cor_hex` | `@IsHexColor` | `z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()` |
| `responsavel_pessoa_id` | `@IsString @IsNotEmpty` | `z.string().uuid()` |
| `conta_id` | `@IsString @IsNotEmpty` | `z.string().uuid()` |
| `data_inicio` | `@IsDate` | `z.coerce.date()` |
| `data_fim` | `@IsOptional @IsDate` | `z.coerce.date().optional()` |
| `orcamento_receita` | `@IsNumber` | `z.number().nonnegative()` |
| `orcamento_despesa` | `@IsNumber` | `z.number().nonnegative()` |

### 5.2 `auth`

| Campo | Zod |
|---|---|
| `login` | `z.string().min(1)` |
| `senha` | `z.string().min(1)` |

### 5.3 `cat-receita` e `cat-despesa`

| Campo | Zod |
|---|---|
| `nome` | `z.string().min(1)` |
| `cor_hex` | `z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()` |

### 5.4 `contas`

| Campo | class-validator | Zod |
|---|---|---|
| `descricao` | `@IsString @IsNotEmpty` | `z.string().min(1)` |
| `banco` | `@IsOptional @IsString` | `z.string().optional()` |
| `tipo_conta` | `@IsEnum(TipoConta)` | `z.nativeEnum(TipoConta)` |
| `num_conta` | `@IsOptional @IsString` | `z.string().optional()` |
| `agencia` | `@IsOptional @IsString` | `z.string().optional()` |
| `saldo_inicial` | `@IsDecimal` | `z.number().nonnegative()` |
| `cor_hex` | `@IsOptional @IsString` | `z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()` |

### 5.5 `despesas` e `receitas`

| Campo | Zod |
|---|---|
| `nome` | `z.string().min(1)` |
| `cat_despesa_id` / `cat_receita_id` | `z.number().int().positive()` |
| `cor_hex` | `z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()` |
| `requer_pessoa`, `requer_acao`, `requer_conta`, `requer_comprovante` | `z.boolean()` |

### 5.6 `grupos-familiares`

| Campo | Zod |
|---|---|
| `nome_familia` | `z.string().min(1)` |

### 5.7 `pessoas`

| Campo | class-validator | Zod |
|---|---|---|
| `nome_completo` | `@IsString @IsNotEmpty` | `z.string().min(1)` |
| `url_foto` | `@IsOptional @IsString` | `z.string().url().optional()` |
| `cpf` | `@IsOptional @IsCpf` | `CpfSchema.optional()` |
| `data_nascimento` | `@IsDateString` | `z.string().date()` |
| `sexo` | `@IsEnum(Sexo)` | `z.nativeEnum(Sexo)` |
| `estado_civil` | `@IsOptional @IsEnum(EstadoCivil)` | `z.nativeEnum(EstadoCivil).optional()` |
| `email` | `@IsOptional @IsEmail` | `z.string().email().optional()` |
| `telefone_celular` | `@IsOptional @IsString` | `z.string().optional()` |
| campos de endereço | `@IsOptional @IsString` | `z.string().optional()` (cada um) |
| `grupo_familiar_id` | `@IsOptional @IsString` | `z.string().uuid().optional()` |

### 5.8 `usuarios`

| Campo | class-validator | Zod |
|---|---|---|
| `nome_usuario` | `@IsString @IsNotEmpty` | `z.string().min(1)` |
| `email_login` | `@IsEmail` | `z.string().email()` |
| `url_imagem_perfil` | `@IsOptional @IsUrl` | `z.string().url().optional()` |
| `senha` | `@MinLength(8)` | `z.string().min(8)` |
| `perfil` | `@IsEnum(Perfil)` | `z.nativeEnum(Perfil)` |
| `ativo` | `@IsBoolean` | `z.boolean()` |

### 5.9 `vinculos-membresia`

DTO atual sem validação. Schema completo a ser criado:

| Campo | Zod |
|---|---|
| `pessoa_id` | `z.string().uuid()` |
| `rol` | `z.nativeEnum(VinculoRol)` |
| `data_admissao` | `z.coerce.date()` |
| `forma_admissao` | `z.nativeEnum(FormaAdmissao)` |
| `igreja_origem` | `z.string().optional()` |
| `data_exclusao` | `z.coerce.date().optional()` |
| `modalidade_exclusao` | `z.nativeEnum(ModalidadeExclusao).optional()` |
| `igreja_destino` | `z.string().optional()` |
| `vinculo_ativo` | `z.boolean().default(true)` |

---

## 6. Arquivos a Remover

Após a migração, o decorator `src/core/decorators/is-cpf.decorator.ts` pode ser removido, pois a lógica migra para `src/core/schemas/cpf.schema.ts`.

---

## 7. Checklist de Implementação

- [ ] Instalar `nestjs-zod` e `zod`; desinstalar `class-validator` e `class-transformer`
- [ ] Criar `src/core/schemas/cpf.schema.ts` com a lógica do CPF
- [ ] Atualizar `main.ts` com `ZodValidationPipe` global
- [ ] Migrar DTOs: `acoes` (2 arquivos)
- [ ] Migrar DTOs: `auth` (1 arquivo)
- [ ] Migrar DTOs: `cat-receita` (2 arquivos)
- [ ] Migrar DTOs: `cat-despesa` (2 arquivos)
- [ ] Migrar DTOs: `contas` (2 arquivos)
- [ ] Migrar DTOs: `despesas` (2 arquivos)
- [ ] Migrar DTOs: `receitas` (2 arquivos)
- [ ] Migrar DTOs: `grupos-familiares` (2 arquivos)
- [ ] Migrar DTOs: `pessoas` (2 arquivos)
- [ ] Migrar DTOs: `usuarios` (2 arquivos)
- [ ] Migrar DTOs: `vinculos-membresia` (2 arquivos)
- [ ] Remover `src/core/decorators/is-cpf.decorator.ts`
- [ ] Verificar build sem erros
