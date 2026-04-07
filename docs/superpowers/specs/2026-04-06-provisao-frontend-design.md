# ProVisão Frontend — Design Spec

**Data:** 2026-04-06  
**Diretório alvo:** `provisao_frontend/`  
**API:** `provisao_api/` (NestJS + PostgreSQL, JWT multi-tenant por `igreja_id`)

---

## 1. Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Framework | Next.js 15 (App Router) |
| Linguagem | TypeScript |
| Estilo | Tailwind CSS v4 |
| Componentes | shadcn/ui |
| Ícones | Lucide React (monocromático, adapta ao tema) |
| Server state | TanStack Query (React Query) v5 |
| Client state | Zustand |
| Formulários | React Hook Form + Zod |
| Temas | next-themes (claro padrão + toggle escuro) |
| HTTP client | fetch nativo com wrapper tipado por módulo |
| Formatação | date-fns (datas), Intl (moeda BRL) |

---

## 2. Paleta de Cores

Derivada diretamente do logotipo ProVisão.

### Tokens CSS (variáveis Tailwind)

```css
/* Primárias (do logo) */
--color-brand-purple:   #7B4FC9   /* sidebar, botões primários, badges */
--color-brand-purple-light: #9B6FE4  /* hover states */
--color-brand-purple-muted: #E8D9FF  /* backgrounds de cards, badges light */
--color-brand-lime:     #C5D44E   /* KPIs receita, itens ativos, accent */

/* Semânticas financeiras */
--color-receita:  #16A34A  /* positivo */
--color-despesa:  #DC2626  /* negativo */
--color-warning:  #CA8A04
--color-info:     #2563EB

/* Tema claro (padrão) */
--bg-page:    #F5F3FF   /* roxo ultralight */
--bg-card:    #FFFFFF
--bg-sidebar: #7B4FC9   /* roxo sólido */
--text-primary:   #1A0A2E
--text-secondary: #6B7280
--border:     #E0D7FF

/* Tema escuro */
--bg-page-dark:    #0F0A1F  /* roxo profundo */
--bg-card-dark:    #1C1232
--bg-sidebar-dark: #150D2B
--text-primary-dark:   #F0EAFF
--text-secondary-dark: #9CA3AF
--border-dark: #2A2A4A
```

### Tipografia

- **Fonte:** Inter (Google Fonts)
- **Hierarquia:** `font-bold text-2xl` (page title) → `font-semibold text-base` (section) → `text-sm` (body) → `text-xs` (labels/meta)

---

## 3. Estrutura de Rotas (Next.js App Router)

```
app/
├── layout.tsx                    # Root layout (next-themes provider)
├── (auth)/                       # Sem sidebar
│   ├── layout.tsx                # Layout centralizado com logo
│   ├── login/page.tsx
│   ├── register/page.tsx
│   ├── forgot-password/page.tsx
│   └── set-password/page.tsx     # ?token= via searchParams
└── (app)/                        # Com sidebar
    ├── layout.tsx                # Sidebar + Header persistentes
    ├── dashboard/page.tsx
    ├── pessoas/
    │   ├── page.tsx              # Listagem com busca e filtros
    │   ├── novo/page.tsx         # Formulário de cadastro
    │   └── [id]/page.tsx         # Perfil completo + histórico de membresia
    ├── grupos-familiares/
    │   └── page.tsx              # CRUD em drawer/modal
    ├── membresia/
    │   ├── page.tsx              # Listagem de vínculos
    │   └── novo/page.tsx
    ├── contas/
    │   └── page.tsx              # Cards de contas com saldo
    ├── lancamentos/
    │   └── page.tsx              # Tabela com filtros de data/tipo/conta
    ├── acoes/
    │   ├── page.tsx              # Cards de ações com progresso de orçamento
    │   └── [id]/page.tsx         # Detalhe com lançamentos vinculados
    ├── categorias/
    │   └── page.tsx              # Tabs: Cat. Receita | Cat. Despesa
    ├── tipos/
    │   └── page.tsx              # Tabs: Tipos Receita | Tipos Despesa
    ├── usuarios/
    │   └── page.tsx              # Tabela + ativação de conta
    └── logs/
        └── page.tsx              # Audit log paginado com filtros
```

---

## 4. Arquitetura de Pastas

```
provisao_frontend/
├── app/                    # Rotas Next.js (acima)
├── components/
│   ├── layout/
│   │   ├── Sidebar.tsx         # Nav principal com grupos colapsáveis
│   │   ├── MobileDrawer.tsx    # Sidebar em sheet para mobile
│   │   ├── Header.tsx          # Breadcrumb + toggle tema + avatar
│   │   └── nav-items.ts        # Definição dos itens de menu
│   ├── ui/                 # shadcn/ui (gerados via CLI)
│   └── shared/
│       ├── DataTable.tsx       # Tabela reutilizável com paginação
│       ├── PageHeader.tsx      # Título + botão de ação primária
│       ├── FormField.tsx       # Wrapper de label + input + erro
│       ├── StatusBadge.tsx     # Badge de perfil/rol/tipo
│       ├── ConfirmDialog.tsx   # Modal de confirmação para DELETEs
│       └── CurrencyDisplay.tsx # Formata Decimal em R$ xx.xxx,xx
├── lib/
│   ├── api/
│   │   ├── client.ts           # fetch wrapper com JWT + error handling
│   │   ├── auth.ts
│   │   ├── pessoas.ts
│   │   ├── grupos-familiares.ts
│   │   ├── membresia.ts
│   │   ├── contas.ts
│   │   ├── lancamentos.ts
│   │   ├── acoes.ts
│   │   ├── categorias.ts       # cat-despesa + cat-receita
│   │   ├── tipos.ts            # despesas + receitas (tipos)
│   │   ├── usuarios.ts
│   │   └── logs.ts
│   ├── schemas/            # Zod schemas espelhando DTOs do backend
│   │   └── lancamento.schema.ts  # ex: valida campos condicionais
│   └── utils.ts            # formatCurrency, formatDate, getInitials
├── hooks/
│   ├── useAuth.ts          # Lê JWT do localStorage, expõe user + logout
│   ├── useTheme.ts         # Wrapper de next-themes
│   └── usePermission.ts    # Verifica perfil do usuário logado
├── stores/
│   ├── auth.store.ts       # Zustand: token, user, setAuth, clear
│   └── theme.store.ts      # Zustand: tema atual (sincroniza next-themes)
└── middleware.ts           # Redireciona /app/* se sem JWT; redireciona / → /login
```

---

## 5. Autenticação & Controle de Acesso

### Fluxo de autenticação

1. **Login** (`POST /auth/login`): salva JWT no `localStorage` via Zustand store
2. **Middleware Next.js**: em rotas `(app)/`, verifica presença e validade do token; redireciona para `/login` se ausente
3. **Registro** (`POST /auth/register`): cria conta com `ativo: false`; admin ativa; email dispara `set-password`
4. **Set-password** (`POST /auth/set-password`): usado tanto na ativação inicial quanto no "esqueci a senha"

### Perfis e visibilidade de menu

| Rota | ADMIN | GESTOR | TESOUREIRO | OPERADOR | AUDITOR | SECRETARIO |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Pessoas | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Grupos / Membresia | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Contas | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Lançamentos | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ações | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Categorias / Tipos | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Usuários | ✅ | ✅ | ✅ | — | ✅ | — |
| Logs | ✅ | — | — | — | ✅ | — |

A tabela representa **visibilidade no menu** (acesso de leitura). Botões de escrita/exclusão são ocultados pelo `usePermission` com base nas permissões detalhadas abaixo:

| Recurso | Criar/Editar | Excluir |
|---|---|---|
| Pessoas | ADMIN, GESTOR, SECRETARIO | ADMIN, SECRETARIO |
| Grupos / Membresia | ADMIN, GESTOR, SECRETARIO | ADMIN, SECRETARIO |
| Contas | ADMIN, GESTOR, TESOUREIRO | ADMIN, TESOUREIRO |
| Lançamentos (receitas/despesas) | ADMIN, TESOUREIRO, OPERADOR | ADMIN, TESOUREIRO |
| Ações | ADMIN, GESTOR | ADMIN, GESTOR |
| Categorias / Tipos | ADMIN, GESTOR, TESOUREIRO | ADMIN, TESOUREIRO |
| Usuários | ADMIN, GESTOR | ADMIN |

O hook `usePermission` oculta itens de menu e desabilita botões de ação de acordo com o perfil extraído do JWT.

---

## 6. Dashboard (Home)

### KPIs exibidos (misto)

**Linha 1 — Financeiro:**
- Receitas do mês (verde + variação vs. mês anterior)
- Despesas do mês (vermelho + variação)
- Saldo total consolidado de todas as contas

**Linha 2 — Membresia:**
- Total de comungantes
- Total de não-comungantes
- Total de grupos familiares

**Linha 3 — Ações em andamento:**
- Cards compactos com nome, responsável, progresso de orçamento (barra receita/despesa vs. orçamento)

**Linha 4 — Últimos lançamentos:**
- Tabela simplificada: data, tipo, conta, valor (colorido por tipo), observação

Todos os KPIs são buscados via TanStack Query com `staleTime: 5min` e indicador de loading skeleton.

---

## 7. Padrões de Componentes

### Listagem (todas as entidades)

- `PageHeader` com título, contagem de registros e botão "Novo" (visível conforme perfil)
- Campo de busca com debounce (300ms)
- Dropdown de filtros relevantes por módulo
- `DataTable` com colunas configuráveis, ordenação e paginação server-side (20 itens/página)
- Ações por linha: visualizar (olho) + editar (lápis) + excluir (lixo, apenas ADMIN) — ícones Lucide

### Formulários

- React Hook Form com validação Zod client-side
- Zod schemas espelham as regras do backend (campos obrigatórios, tamanhos, enums)
- Campos condicionais em lançamentos: quando `receita` ou `despesa` selecionada, busca o tipo e exibe campos extras se `requer_pessoa`, `requer_acao`, `requer_conta` ou `requer_comprovante` forem `true`
- Upload de comprovante via `<input type="file">` com preview — envia para `/uploads` da API
- Feedback de erro inline por campo + toast de sucesso/erro (shadcn Toaster)

### Formulário de Pessoa

Campos: nome completo, CPF, data de nascimento, sexo, estado civil, email, telefone, CEP (com auto-fill via API de CEP), logradouro, número, complemento, bairro, cidade, estado, grupo familiar, foto (upload com preview circular).

### Modal vs. Página

- Entidades simples (Grupos Familiares, Categorias, Tipos, Contas): CRUD em `Dialog` (modal)
- Entidades complexas (Pessoas, Ações, Lançamentos): páginas dedicadas com rota própria

---

## 8. Responsividade

| Breakpoint | Comportamento da Sidebar |
|---|---|
| `< 768px` (mobile) | Sidebar oculta; ícone hamburger abre `Sheet` (drawer) |
| `768–1024px` (tablet) | Sidebar colapsada (apenas ícones) |
| `> 1024px` (desktop) | Sidebar expandida com labels |

Tabelas em mobile: colunas reduzidas para nome + valor + ações; linha expansível para detalhes.

---

## 9. Tratamento de Erros

- **401 Unauthorized:** interceptado no `client.ts` → limpa store + redireciona para `/login`
- **403 Forbidden:** toast "Sem permissão para esta ação"
- **404:** página `not-found.tsx` com link para dashboard
- **422 / 400 (Zod do backend):** erros de campo exibidos inline no formulário
- **500:** toast genérico "Erro no servidor. Tente novamente."
- **Rede offline:** banner persistente no topo

---

## 10. Configurações do Projeto

```json
// package.json (principais dependências)
{
  "next": "^15",
  "react": "^19",
  "typescript": "^5",
  "tailwindcss": "^4",
  "@tanstack/react-query": "^5",
  "zustand": "^4",
  "react-hook-form": "^7",
  "zod": "^3",
  "next-themes": "^0.4",
  "lucide-react": "^0.400",
  "date-fns": "^3",
  "class-variance-authority": "^0.7",
  "clsx": "^2",
  "tailwind-merge": "^2"
}
```

```
// .env.local
NEXT_PUBLIC_API_URL=http://localhost:3000
```

---

## 11. Itens Fora de Escopo

- Internacionalização (i18n) — app é em português apenas
- Testes automatizados — fora do escopo desta fase
- PWA / offline-first — fora do escopo
- Super-admin para gerenciar múltiplas igrejas — não existe na API atual
