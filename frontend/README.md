# imob frontend

Aplicação web do SaaS imobiliário multi-tenant. Aplicação independente do `backend/` — próprio
`package.json`, próprio lockfile, próprio build, próprios testes. Ver
[`../README.md`](../README.md) para como os dois projetos se relacionam neste repositório
(não é monorepo/workspace).

## Requirements

- Node — versão fixada em [`.nvmrc`](.nvmrc) (`v22.16.0`), a mesma da raiz e do `backend/`.
- pnpm (nunca npm/yarn — ver `CLAUDE.md`).

## Install

```bash
cd frontend
pnpm install
```

## Dev

```bash
pnpm dev
```

Sobe em `http://localhost:5173` por padrão. Compila e roda de forma independente do backend
(this task, section 72) — nenhuma chamada de rede acontece na home; features futuras que
consumirem a API real precisarão do backend rodando (ver `backend/README.md`) e de
`VITE_API_URL` apontando para ele.

## Typecheck / lint / test / build

```bash
pnpm typecheck   # tsc -b, sem emitir arquivos
pnpm lint        # ESLint (TypeScript + React + React Hooks)
pnpm test        # Vitest, execução única
pnpm test:watch  # Vitest, modo watch
pnpm build       # tsc -b && vite build → dist/
pnpm preview     # serve o build de dist/ localmente
pnpm format      # Prettier --write
```

`dist/` nunca é versionado (`.gitignore` na raiz do repositório).

## Env

Copie `.env.example` para `.env` (nunca versionado) e ajuste se necessário:

```env
VITE_API_URL=http://localhost:3000
```

Todo acesso a variáveis de ambiente passa por `src/lib/env.ts` (validado com Zod, falha rápido
na inicialização se algo estiver ausente/inválido) — nenhum outro módulo lê
`import.meta.env` diretamente (regra reforçada por ESLint, ver `CLAUDE.md`).

## Architecture summary

Fundação mínima, tipada e testável — sem feature de negócio ainda (ver `CLAUDE.md` para as
regras arquiteturais completas). Resumo:

```text
src/
├── app/
│   ├── providers/     AppProviders (TanStack Query, Toaster) + QueryClient factory
│   ├── router/        tabela de rotas central (React Router) + error boundary
│   └── App.tsx         composição: AppProviders → RouterProvider
├── components/
│   ├── ui/             gerado/adaptado do shadcn — nunca lógica de negócio
│   └── common/          componentes genéricos da aplicação
├── features/           lógica específica de negócio, uma pasta por feature — vazio até a
│                        primeira feature real (Properties/Tenants/Auth) começar
├── lib/
│   ├── env.ts           único ponto de leitura de import.meta.env
│   └── http/             apiFetch() + ApiError — fetch nativo, sem Axios
├── pages/               composição de features/rotas — HomePage, NotFoundPage
├── styles/              CSS global (Tailwind + tokens shadcn)
├── test/                setup do Vitest + renderWithProviders()
└── main.tsx
```

**Estado**: server state → TanStack Query; formulários → React Hook Form + Zod; estado
navegável/compartilhável → URL; estado de UI local → `useState`/`useReducer`. Zustand
deliberadamente **não instalado** — só entra quando surgir uma necessidade real de estado
cliente global cruzando features.

**Rotas hoje**: `/` (home mínima, prova que o toolchain funciona) e `*` (404). Nada além disso
— sem dashboard, sem listagem de imóveis, sem tenants, sem login.

**UI**: Tailwind CSS v4 + shadcn/ui (`components.json`, alias `@/*` → `src/*` consistente em
TypeScript/Vite/Vitest/shadcn). Componentes instalados: `button`, `card`, `input`, `label`,
`badge`, `separator`, `skeleton`, `sonner`. Tema claro; a arquitetura de tokens (CSS variables)
não impede um tema escuro futuro, mas nenhum toggle existe ainda.

**Autenticação**: não implementada. **Tenant handling**: não implementado — o mecanismo
temporário `X-Tenant-Id` do backend será decidido explicitamente pela futura feature Properties,
nunca configurado globalmente aqui.
