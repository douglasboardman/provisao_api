# Zod DTO Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir `class-validator` + `class-transformer` por `zod` + `nestjs-zod` em todos os 21 DTOs da API, mantendo validação tipada e expressiva.

**Architecture:** Cada arquivo `create-*.dto.ts` define um schema Zod e exporta a classe DTO via `createZodDto()`. Os `update-*.dto.ts` reutilizam o schema via `.partial()`. Um schema CPF reutilizável é extraído para `src/core/schemas/cpf.schema.ts` usando a lógica da classe `Cpf` existente.

**Tech Stack:** `nestjs-zod`, `zod`, NestJS 11, Prisma enums

---

### Task 1: Instalar dependências e configurar pipe global

**Files:**
- Modify: `provisao_api/package.json`
- Modify: `provisao_api/src/main.ts`

- [ ] **Step 1: Instalar nestjs-zod e zod; remover class-validator e class-transformer**

```bash
cd provisao_api
npm install nestjs-zod zod
npm uninstall class-validator class-transformer
```

Expected: `package.json` atualizado, sem `class-validator` e `class-transformer`.

- [ ] **Step 2: Atualizar `main.ts` com ZodValidationPipe**

Substituir o conteúdo de `src/main.ts`:

```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ZodValidationPipe } from 'nestjs-zod';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ZodValidationPipe());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

- [ ] **Step 3: Verificar que o projeto compila**

```bash
npm run build
```

Expected: saída sem erros de TypeScript.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts package.json package-lock.json
git commit -m "chore: instala nestjs-zod, remove class-validator e class-transformer"
```

---

### Task 2: Criar schema CPF reutilizável

**Files:**
- Create: `provisao_api/src/core/schemas/cpf.schema.ts`

- [ ] **Step 1: Criar `src/core/schemas/cpf.schema.ts`**

```ts
import { z } from 'zod';
import { Cpf } from '../classes/cpf.class';

export const CpfSchema = z
  .string()
  .refine((value) => Cpf.isValid(value), {
    message: 'O CPF fornecido é inválido.',
  });
```

- [ ] **Step 2: Verificar que o projeto compila**

```bash
npm run build
```

Expected: saída sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/core/schemas/cpf.schema.ts
git commit -m "feat: adiciona CpfSchema Zod em src/core/schemas"
```

---

### Task 3: Migrar DTOs de `cat-receita`

**Files:**
- Modify: `provisao_api/src/cat-receita/dto/create-cat-receita.dto.ts`
- Modify: `provisao_api/src/cat-receita/dto/update-cat-receita.dto.ts`

- [ ] **Step 1: Substituir `create-cat-receita.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateCatReceitaSchema = z.object({
  nome: z.string().min(1, 'O nome da categoria de receita não pode ser vazio.'),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
});

export class CreateCatReceitaDto extends createZodDto(CreateCatReceitaSchema) {}
```

- [ ] **Step 2: Substituir `update-cat-receita.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateCatReceitaSchema } from './create-cat-receita.dto';

export class UpdateCatReceitaDto extends createZodDto(CreateCatReceitaSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/cat-receita/dto/
git commit -m "feat: migra DTOs de cat-receita para nestjs-zod"
```

---

### Task 4: Migrar DTOs de `cat-despesa`

**Files:**
- Modify: `provisao_api/src/cat-despesa/dto/create-cat-despesa.dto.ts`
- Modify: `provisao_api/src/cat-despesa/dto/update-cat-despesa.dto.ts`

- [ ] **Step 1: Substituir `create-cat-despesa.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateCatDespesaSchema = z.object({
  nome: z.string().min(1, 'O nome da categoria de despesa não pode ser vazio.'),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
});

export class CreateCatDespesaDto extends createZodDto(CreateCatDespesaSchema) {}
```

- [ ] **Step 2: Substituir `update-cat-despesa.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateCatDespesaSchema } from './create-cat-despesa.dto';

export class UpdateCatDespesaDto extends createZodDto(CreateCatDespesaSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/cat-despesa/dto/
git commit -m "feat: migra DTOs de cat-despesa para nestjs-zod"
```

---

### Task 5: Migrar DTOs de `receitas`

**Files:**
- Modify: `provisao_api/src/receitas/dto/create-receita.dto.ts`
- Modify: `provisao_api/src/receitas/dto/update-receita.dto.ts`

- [ ] **Step 1: Substituir `create-receita.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateReceitaSchema = z.object({
  nome: z.string().min(1, 'O campo nome não pode ser nulo.'),
  cat_receita_id: z.number().int().positive('O campo cat_receita_id deve ser um número inteiro positivo.'),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
  requer_pessoa: z.boolean(),
  requer_acao: z.boolean(),
  requer_conta: z.boolean(),
  requer_comprovante: z.boolean(),
});

export class CreateReceitaDto extends createZodDto(CreateReceitaSchema) {}
```

- [ ] **Step 2: Substituir `update-receita.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateReceitaSchema } from './create-receita.dto';

export class UpdateReceitaDto extends createZodDto(CreateReceitaSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/receitas/dto/
git commit -m "feat: migra DTOs de receitas para nestjs-zod"
```

---

### Task 6: Migrar DTOs de `despesas`

**Files:**
- Modify: `provisao_api/src/despesas/dto/create-despesa.dto.ts`
- Modify: `provisao_api/src/despesas/dto/update-despesa.dto.ts`

- [ ] **Step 1: Substituir `create-despesa.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateDespesaSchema = z.object({
  nome: z.string().min(1, 'O campo nome não pode ser nulo.'),
  cat_despesa_id: z.number().int().positive('O campo cat_despesa_id deve ser um número inteiro positivo.'),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
  requer_pessoa: z.boolean(),
  requer_acao: z.boolean(),
  requer_conta: z.boolean(),
  requer_comprovante: z.boolean(),
});

export class CreateDespesaDto extends createZodDto(CreateDespesaSchema) {}
```

- [ ] **Step 2: Substituir `update-despesa.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateDespesaSchema } from './create-despesa.dto';

export class UpdateDespesaDto extends createZodDto(CreateDespesaSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/despesas/dto/
git commit -m "feat: migra DTOs de despesas para nestjs-zod"
```

---

### Task 7: Migrar DTOs de `grupos-familiares`

**Files:**
- Modify: `provisao_api/src/grupos-familiares/dto/create-grupos-familiare.dto.ts`
- Modify: `provisao_api/src/grupos-familiares/dto/update-grupos-familiare.dto.ts`

- [ ] **Step 1: Substituir `create-grupos-familiare.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateGruposFamiliareSchema = z.object({
  nome_familia: z.string().min(1, 'O nome da família não pode ser vazio.'),
});

export class CreateGruposFamiliareDto extends createZodDto(CreateGruposFamiliareSchema) {}
```

- [ ] **Step 2: Substituir `update-grupos-familiare.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateGruposFamiliareSchema } from './create-grupos-familiare.dto';

export class UpdateGruposFamiliareDto extends createZodDto(CreateGruposFamiliareSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/grupos-familiares/dto/
git commit -m "feat: migra DTOs de grupos-familiares para nestjs-zod"
```

---

### Task 8: Migrar DTOs de `auth`

**Files:**
- Modify: `provisao_api/src/auth/dto/sign-in.dto.ts`

- [ ] **Step 1: Substituir `sign-in.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const SignInSchema = z.object({
  login: z.string().min(1, 'O campo login não pode estar vazio.'),
  senha: z.string().min(1, 'O campo senha não pode estar vazio.'),
});

export class SignInDto extends createZodDto(SignInSchema) {}
```

- [ ] **Step 2: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/auth/dto/sign-in.dto.ts
git commit -m "feat: migra SignInDto para nestjs-zod"
```

---

### Task 9: Migrar DTOs de `contas`

**Files:**
- Modify: `provisao_api/src/contas/dto/create-conta.dto.ts`
- Modify: `provisao_api/src/contas/dto/update-conta.dto.ts`

- [ ] **Step 1: Substituir `create-conta.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { tipo_conta as TipoConta } from '@prisma/client';

export const CreateContaSchema = z.object({
  descricao: z.string().min(1, "O campo 'descricao' não pode estar vazio."),
  banco: z.string().optional(),
  tipo_conta: z.nativeEnum(TipoConta, {
    errorMap: () => ({ message: "O campo 'tipo_conta' deve ser um valor válido de tipo_conta." }),
  }),
  num_conta: z.string().optional(),
  agencia: z.string().optional(),
  saldo_inicial: z.number().nonnegative("O campo 'saldo_inicial' não pode ser negativo."),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
});

export class CreateContaDto extends createZodDto(CreateContaSchema) {}
```

- [ ] **Step 2: Substituir `update-conta.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateContaSchema } from './create-conta.dto';

export class UpdateContaDto extends createZodDto(CreateContaSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/contas/dto/
git commit -m "feat: migra DTOs de contas para nestjs-zod"
```

---

### Task 10: Migrar DTOs de `acoes`

**Files:**
- Modify: `provisao_api/src/acoes/dto/create-acoe.dto.ts`
- Modify: `provisao_api/src/acoes/dto/update-acoe.dto.ts`

- [ ] **Step 1: Substituir `create-acoe.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateAcoeSchema = z.object({
  nome: z.string().min(1, "O campo 'nome' não pode estar vazio."),
  descricao_detalhada: z.string().optional(),
  cor_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "O campo 'cor_hex' deve ser uma cor hexadecimal válida (ex: #RRGGBB).")
    .optional(),
  responsavel_pessoa_id: z.string().uuid("O campo 'responsavel_pessoa_id' deve ser um UUID válido."),
  conta_id: z.string().uuid("O campo 'conta_id' deve ser um UUID válido."),
  data_inicio: z.coerce.date({ errorMap: () => ({ message: "O campo 'data_inicio' deve ser uma data válida." }) }),
  data_fim: z.coerce.date({ errorMap: () => ({ message: "O campo 'data_fim' deve ser uma data válida." }) }).optional(),
  orcamento_receita: z.number().nonnegative("O campo 'orcamento_receita' não pode ser negativo."),
  orcamento_despesa: z.number().nonnegative("O campo 'orcamento_despesa' não pode ser negativo."),
});

export class CreateAcoeDto extends createZodDto(CreateAcoeSchema) {}
```

- [ ] **Step 2: Substituir `update-acoe.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateAcoeSchema } from './create-acoe.dto';

export class UpdateAcoeDto extends createZodDto(CreateAcoeSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/acoes/dto/
git commit -m "feat: migra DTOs de acoes para nestjs-zod"
```

---

### Task 11: Migrar DTOs de `usuarios`

**Files:**
- Modify: `provisao_api/src/usuarios/dto/create-usuario.dto.ts`
- Modify: `provisao_api/src/usuarios/dto/update-usuario.dto.ts`

- [ ] **Step 1: Substituir `create-usuario.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { usuarios_perfil as Perfil } from '@prisma/client';

export const CreateUsuarioSchema = z.object({
  nome_usuario: z.string().min(1, 'O nome de usuário não pode estar vazio.'),
  email_login: z.string().email('O e-mail de login fornecido é inválido.'),
  url_imagem_perfil: z.string().url('O endereço da imagem do usuário não é uma URL válida.').optional(),
  senha: z.string().min(8, 'A senha deve ter no mínimo 8 (oito) caracteres.'),
  perfil: z.nativeEnum(Perfil, {
    errorMap: () => ({ message: 'O perfil fornecido é inválido.' }),
  }),
  ativo: z.boolean({ message: 'O campo "ativo" deve ser um booleano (true ou false).' }),
});

export class CreateUsuarioDto extends createZodDto(CreateUsuarioSchema) {}
```

- [ ] **Step 2: Substituir `update-usuario.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateUsuarioSchema } from './create-usuario.dto';

export class UpdateUsuarioDto extends createZodDto(CreateUsuarioSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/usuarios/dto/
git commit -m "feat: migra DTOs de usuarios para nestjs-zod"
```

---

### Task 12: Migrar DTOs de `pessoas`

**Files:**
- Modify: `provisao_api/src/pessoas/dto/create-pessoa.dto.ts`
- Modify: `provisao_api/src/pessoas/dto/update-pessoa.dto.ts`

- [ ] **Step 1: Substituir `create-pessoa.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { pessoas_sexo as Sexo, pessoas_estado_civil as EstadoCivil } from '@prisma/client';
import { CpfSchema } from 'src/core/schemas/cpf.schema';

export const CreatePessoaSchema = z.object({
  nome_completo: z.string().min(1, 'O nome da pessoa não pode estar vazio.'),
  url_foto: z.string().url('A URL da foto é inválida.').optional(),
  cpf: CpfSchema.optional(),
  data_nascimento: z.string().date('A data de nascimento precisa estar no formato de data (YYYY-MM-DD).'),
  sexo: z.nativeEnum(Sexo, { errorMap: () => ({ message: 'O sexo informado é inválido.' }) }),
  estado_civil: z.nativeEnum(EstadoCivil, { errorMap: () => ({ message: 'O estado civil informado é inválido.' }) }).optional(),
  email: z.string().email('O email informado é inválido.').optional(),
  telefone_celular: z.string().optional(),
  cep: z.string().optional(),
  logradouro: z.string().optional(),
  numero: z.string().optional(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
  cidade: z.string().optional(),
  estado: z.string().max(2, 'O estado deve ter no máximo 2 caracteres.').optional(),
  grupo_familiar_id: z.string().uuid('O grupo familiar precisa ser um UUID válido.').optional(),
});

export class CreatePessoaDto extends createZodDto(CreatePessoaSchema) {}
```

- [ ] **Step 2: Substituir `update-pessoa.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreatePessoaSchema } from './create-pessoa.dto';

export class UpdatePessoaDto extends createZodDto(CreatePessoaSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/pessoas/dto/
git commit -m "feat: migra DTOs de pessoas para nestjs-zod"
```

---

### Task 13: Migrar DTOs de `vinculos-membresia`

**Files:**
- Modify: `provisao_api/src/vinculos-membresia/dto/create-vinculos-membresia.dto.ts`
- Modify: `provisao_api/src/vinculos-membresia/dto/update-vinculos-membresia.dto.ts`

- [ ] **Step 1: Substituir `create-vinculos-membresia.dto.ts`**

```ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  vinculos_membresia_rol as VinculoRol,
  vinculos_membresia_forma_admissao as FormaAdmissao,
  vinculos_membresia_modalidade_exclusao as ModalidadeExclusao,
} from '@prisma/client';

export const CreateVinculosMembresiaSchema = z.object({
  pessoa_id: z.string().uuid("O campo 'pessoa_id' deve ser um UUID válido."),
  rol: z.nativeEnum(VinculoRol, { errorMap: () => ({ message: 'O rol informado é inválido.' }) }),
  data_admissao: z.coerce.date({ errorMap: () => ({ message: "O campo 'data_admissao' deve ser uma data válida." }) }),
  forma_admissao: z.nativeEnum(FormaAdmissao, { errorMap: () => ({ message: 'A forma de admissão informada é inválida.' }) }),
  igreja_origem: z.string().optional(),
  data_exclusao: z.coerce.date({ errorMap: () => ({ message: "O campo 'data_exclusao' deve ser uma data válida." }) }).optional(),
  modalidade_exclusao: z.nativeEnum(ModalidadeExclusao, { errorMap: () => ({ message: 'A modalidade de exclusão informada é inválida.' }) }).optional(),
  igreja_destino: z.string().optional(),
  vinculo_ativo: z.boolean().default(true),
});

export class CreateVinculosMembresiaDto extends createZodDto(CreateVinculosMembresiaSchema) {}
```

- [ ] **Step 2: Substituir `update-vinculos-membresia.dto.ts`**

```ts
import { createZodDto } from 'nestjs-zod';
import { CreateVinculosMembresiaSchema } from './create-vinculos-membresia.dto';

export class UpdateVinculosMembresiaDto extends createZodDto(CreateVinculosMembresiaSchema.partial()) {}
```

- [ ] **Step 3: Verificar build**

```bash
npm run build
```

Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/vinculos-membresia/dto/
git commit -m "feat: migra DTOs de vinculos-membresia para nestjs-zod"
```

---

### Task 14: Remover arquivos legados de class-validator

**Files:**
- Delete: `provisao_api/src/core/decorators/is-cpf.decorator.ts`
- Delete: `provisao_api/src/core/validators/is-cpf.validator.ts`

> **Nota:** A classe `src/core/classes/cpf.class.ts` é mantida — é reutilizada pelo `CpfSchema`.

- [ ] **Step 1: Verificar que nenhum arquivo ainda importa is-cpf.decorator ou is-cpf.validator**

```bash
grep -r "is-cpf" src/ --include="*.ts"
```

Expected: nenhum resultado.

- [ ] **Step 2: Remover arquivos**

```bash
rm src/core/decorators/is-cpf.decorator.ts
rm src/core/validators/is-cpf.validator.ts
```

- [ ] **Step 3: Verificar build final**

```bash
npm run build
```

Expected: saída sem erros.

- [ ] **Step 4: Commit final**

```bash
git add -A
git commit -m "chore: remove decorators e validators legados do class-validator"
```
