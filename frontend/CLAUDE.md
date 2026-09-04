# CLAUDE.md — frontend

Regras permanentes e arquiteturais para o frontend (`imob/frontend/`). Complementa
`backend/CLAUDE.md` (workflow Git/PR/CI é o mesmo para as duas aplicações — ver o `CLAUDE.md`
raiz do repositório se existir, ou o histórico de prompts) — este arquivo cobre apenas decisões
específicas do frontend.

## Stack e ferramentas

- Use `pnpm`. Nunca `npm`/`yarn` — não gera lockfile conflitante com o do backend.
- React + TypeScript, `strict: true` sempre ativo. Nunca relaxar tipos para facilitar setup.
- Evite `any`. Nunca desabilite regras do TypeScript/ESLint globalmente para contornar um erro
  pontual — corrija o tipo real ou peça uma decisão explícita.

## Estratégia de estado

- **Server state** (dados vindos da API) pertence ao **TanStack Query** — nunca `useState` +
  `useEffect` manual para buscar/cachear dados remotos.
- **Form state** pertence ao **React Hook Form + Zod** — nunca estado de formulário controlado
  manualmente campo a campo para formulários reais.
- **Estado navegável/compartilhável** (filtros, paginação, o que devia sobreviver a um reload ou
  a compartilhar um link) pertence à **URL** (query string/params via React Router) — nunca só
  em memória se o usuário esperaria que um link copiado reproduzisse o mesmo estado.
- **Estado de UI local** (aberto/fechado, hover, um passo de wizard) permanece local
  (`useState`/`useReducer`) — não promova para algo global sem necessidade real.
- **Não introduza Zustand** (ou qualquer store global) sem um caso real de estado cliente que
  cruze features e não se encaixe em nenhuma das categorias acima. Não é necessidade
  hipotética — é um requisito concreto já observado no código.

## Organização de código

- `components/ui` é código gerado/adaptado do shadcn (`pnpm dlx shadcn@latest add ...`) — nunca
  lógica de negócio ali. Edições manuais extensas quebram a capacidade de resincronizar com o
  registry no futuro.
- `components/common` é para componentes genéricos da aplicação (não gerados, não específicos
  de uma feature).
- Código de negócio pertence a `features/<feature>/` (api/components/hooks/schemas/types) —
  nunca direto em `components/` ou espalhado em `pages/`. Não crie uma pasta de feature vazia
  antecipando uma tarefa futura; crie quando a feature realmente começar.
- `pages/` é composição — junta features/rotas, não implementa regra de negócio ali.
- `lib/` é infraestrutura compartilhada do frontend (env, HTTP, utils genéricos) — não é um
  depósito indiscriminado. Evite crescer `services/`/`utils/`/`helpers/` genéricos; prefira
  co-locação dentro da própria feature quando o código é específico dela.

## HTTP e ambiente

- Nunca chame `fetch` diretamente de dentro de um componente React — passe por `apiFetch()`
  (`src/lib/http/api-fetch.ts`), consumido através de hooks do TanStack Query.
- Nunca acesse `import.meta.env` fora de `src/lib/env.ts` — todo outro módulo importa o `env`
  já validado por Zod. Regra reforçada por lint (`eslint.config.js`,
  `no-restricted-syntax` sobre `import.meta.env`), não é só uma convenção documentada.
- Não invente autenticação (`Authorization`, `Bearer` fake, `X-User`, `X-Admin`) nem o header
  temporário de tenant (`X-Tenant-Id`) neste nível genérico — cada mecanismo real é decidido
  explicitamente pela feature que primeiro precisar dele.

## Componentes shadcn

- Não adicione um novo componente shadcn (`pnpm dlx shadcn@latest add ...`) só porque pode ser
  útil depois — adicione quando uma tarefa realmente for usá-lo.

## Processo

- Mudanças funcionais seguem o mesmo fluxo do backend: uma branch, um PR, CI verde, aprovação
  humana antes do merge — nunca commit direto em `main`, nunca merge sem aprovação explícita.
