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

Sobe em `http://localhost:5173` por padrão (ou a próxima porta livre, se ocupada). A Home
continua sem nenhuma chamada de rede; `/properties` precisa do backend rodando (ver
`backend/README.md`, modo `pnpm dev:full` para exercitar Properties com tenant `READY`) e de
`VITE_API_URL`/`VITE_TENANT_ID` configurados.

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
VITE_TENANT_ID=
```

Todo acesso a variáveis de ambiente passa por `src/lib/env.ts` (validado com Zod, falha rápido
na inicialização se algo estiver ausente/inválido) — nenhum outro módulo lê
`import.meta.env` diretamente (regra reforçada por ESLint, ver `CLAUDE.md`).

`VITE_TENANT_ID` é **opcional** no boot da aplicação — a Home continua funcionando sem ele.
Só é exigido pela página `/properties` (feature Properties, Tenant Data Plane), que mostra um
estado dedicado ("Tenant de desenvolvimento não configurado.") e não faz nenhuma requisição
quando ele está ausente ou inválido. Deve ser o UUID de um tenant `READY` provisionado
localmente (ver `backend/README.md`, seção "Testando Properties").

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
├── features/
│   └── properties/     catálogo de imóveis (api/components/schemas/hooks/lib) — primeira
│                        feature real; demais features (Tenants/Auth) ainda não começaram
├── lib/
│   ├── env.ts           único ponto de leitura de import.meta.env
│   └── http/             apiFetch() + ApiError — fetch nativo, sem Axios
├── pages/               composição de features/rotas — HomePage, PropertiesPage,
│                        PropertyDetailsPage, NewPropertyPage, EditPropertyPage, NotFoundPage
├── styles/              CSS global (Tailwind + tokens shadcn)
├── test/                setup do Vitest + renderWithProviders()
└── main.tsx
```

**Estado**: server state → TanStack Query; formulários → React Hook Form + Zod; estado
navegável/compartilhável → URL; estado de UI local → `useState`/`useReducer`. Zustand
deliberadamente **não instalado** — só entra quando surgir uma necessidade real de estado
cliente global cruzando features.

**Rotas hoje**: `/` (home mínima, com um link "Ver imóveis"), `/properties` (catálogo),
`/properties/:id` (detalhe), `/properties/new` (criação), `/properties/:id/edit` (edição) e
`*` (404). Sem dashboard, sem tenants, sem login, sem gestão de mídia (upload/reorder/cover/
delete) e sem exclusão/arquivamento de imóvel pela UI ainda.

**UI**: Tailwind CSS v4 + shadcn/ui (`components.json`, alias `@/*` → `src/*` consistente em
TypeScript/Vite/Vitest/shadcn). Componentes instalados: `button`, `card`, `input`, `label`,
`badge`, `separator`, `select`, `skeleton`, `sonner`, `textarea`. Tema claro; a arquitetura de
tokens (CSS variables) não impede um tema escuro futuro, mas nenhum toggle existe ainda.

**Autenticação**: não implementada.

### Catálogo de imóveis (`/properties`)

- Consome `GET /api/v1/properties` (`backend/src/modules/properties/http/property-routes.ts`)
  através de `listProperties()` (`src/features/properties/api/list-properties.ts`) — uma única
  chamada HTTP por carregamento lógico da página. A capa de cada card vem embutida na própria
  listagem (campo `cover`, com `variants.thumbnail`/`variants.card`) — **nunca** existe uma
  chamada `GET /properties/:id/media` por card (sem N+1).
- **Tenant context**: o backend ainda usa um header temporário `X-Tenant-Id` (Tenant Data
  Plane, sem autenticação real) — ver `backend/README.md`. Esse header é enviado **apenas**
  pela função de API da feature Properties, nunca globalmente por `apiFetch()` (Control Plane e
  Tenant Data Plane são contextos diferentes — ver `CLAUDE.md`). O tenant id vem de
  `VITE_TENANT_ID` (ver "Env" acima); sem ele, `/properties` mostra um estado dedicado e não
  faz nenhuma requisição.
- **Filtros, ordenação e paginação vivem na URL** (`?q=&status=&property_type=&
transaction_type=&city=&state=&price_min=&price_max=&bedrooms_min=&bathrooms_min=&
parking_spaces_min=&area_min=&area_max=&sort=&order=&page=`, os mesmos nomes que o backend
  aceita) — um link copiado reproduz o mesmo resultado. Só um subconjunto (busca, tipo,
  transação, cidade, estado, preço mín/máx, quartos mín) tem controle visual; o restante
  continua aceito via URL. Valores inválidos (`page=-1`, `price_min=abc`, `status=banana`) são
  ignorados silenciosamente em vez de quebrar a página.
- Server state via TanStack Query (`useProperties`, `src/features/properties/hooks/`) — a
  query key inclui o tenant id, então o cache nunca mistura dados de tenants diferentes.
- Cada `PropertyCard` navega para `/properties/:id` via `Link` do React Router (nunca
  `window.location`).

### Detalhe do imóvel (`/properties/:id`)

- Consome exatamente duas chamadas HTTP por carregamento lógico da página, disparadas em
  paralelo por `PropertyDetailsPage` (`src/pages/PropertyDetailsPage.tsx`) — nunca uma
  sequência property-então-media:
  - `GET /api/v1/properties/:id` via `getPropertyById()`
    (`src/features/properties/api/get-property.ts`, hook `useProperty`) — a resposta nunca
    carrega `cover` (esse campo só existe na listagem); schema próprio (`propertyDetailSchema`)
    reaproveitando os mesmos campos base da listagem.
  - `GET /api/v1/properties/:id/media` via `listPropertyMedia()`
    (`src/features/properties/api/list-property-media.ts`, hook `usePropertyMedia`) — **nunca**
    uma chamada adicional por item de mídia (sem N+1); cada item já traz
    `variants.thumbnail`/`variants.card`/`variants.detail`, cada um independentemente `null`
    até aquela variante existir.
- **Galeria** (`PropertyGallery`, `src/features/properties/components/PropertyGallery.tsx`) é
  puramente apresentacional — nunca faz sua própria chamada HTTP. Seleção da miniatura ativa é
  `useState` local (nunca URL/TanStack Query/Zustand): a mídia padrão (capa, senão a primeira
  por `position`) é recalculada a cada render sempre que a seleção atual não existir mais na
  lista, em vez de sincronizada via `useEffect` — nunca sobrescreve uma seleção do usuário ainda
  válida.
  - Imagem principal: `variants.detail` → `variants.card` → `variants.thumbnail` → `public_url`
    original → placeholder ("Imóvel sem fotos", só quando não há mídia alguma).
  - Miniaturas: `variants.thumbnail` → `variants.card` → `public_url` original — **nunca**
    `detail` (miniatura não precisa da maior variante).
  - `public_url` é campo obrigatório em toda mídia, então essa cadeia de fallback nunca falha
    para um item real — mídia `PROCESSING`/`FAILED`/"READY legado" (sem variantes, migrada
    antes do worker de processamento existir) sempre mostra a melhor URL disponível, nunca
    esconde a foto. `PROCESSING` mostra um badge discreto "Processando" sobre a imagem original.
- Estados de loading/erro são independentes entre property e media (`PropertyDetailsSkeleton`
  vs. `PropertyGallerySkeleton`/`PropertyGalleryErrorState`) — uma falha ao carregar as fotos
  nunca esconde os dados do imóvel que já carregaram. Um 404 de `GET /properties/:id`
  (`ApiError.status === 404`) mostra "Imóvel não encontrado." em vez do erro genérico.
- O `:id` da rota é validado como UUID (`isValidPropertyId`) antes de qualquer requisição — um
  id obviamente inválido (`/properties/abc`) mostra o mesmo estado de não encontrado sem nunca
  chamar a API.
- Mesmo contrato de tenant do catálogo: `X-Tenant-Id` escopado à feature Properties, tenant
  ausente mostra o mesmo estado dedicado sem nenhuma requisição.
- Botão "Editar" navega para `/properties/:id/edit`. A galeria/mídia não são alteradas por esta
  página.

### Criação e edição de imóveis (`/properties/new`, `/properties/:id/edit`)

- Um único componente `PropertyForm`
  (`src/features/properties/components/PropertyForm.tsx`, `mode="create" | "edit"`) é
  reaproveitado pelas duas páginas — nunca dois formulários distintos. React Hook Form +
  Zod (`zodResolver`), organizado em três blocos (Informações principais, Características,
  Localização).
- **Schema do formulário** (`src/features/properties/schemas/property-form.schema.ts`) é
  deliberadamente distinto do schema de resposta da API (`propertyDetailSchema`): seu *input*
  (`PropertyFormValues`) é o que os campos HTML realmente produzem (strings), e seu *output*
  (`PropertyFormOutput`, obtido depois que `zodResolver` valida+transforma no submit) já é o
  payload no formato esperado pelo backend — decimal strings, `null` para campo opcional
  vazio, `number` para os campos inteiros pequenos. Enums (`property_type`/`transaction_type`/
  `status`) reaproveitam os mesmos schemas Zod da listagem/detalhe — nunca uma segunda lista de
  valores.
- **Dinheiro** (`price`/`area_m2`): o input aceita formatos pt-BR ("1000", "1000,50",
  "1.000,50"); `normalizePtBrDecimalString()`
  (`src/features/properties/lib/normalize-decimal-input.ts`) converte para a string decimal
  canônica que o backend espera (nunca um `number` JS na lógica financeira). Ao hidratar o
  formulário de edição, `formatDecimalForPtBrInput()` faz o caminho inverso, só para exibição.
- **Create**: `POST /api/v1/properties` via `createProperty()`
  (`src/features/properties/api/create-property.ts`, hook `useCreateProperty`). Sucesso invalida
  o cache do catálogo (`["properties", tenantId]`) e navega para `/properties/:id` do imóvel
  criado.
- **Edit**: `GET /api/v1/properties/:id` hidrata o formulário **uma única vez**
  (`defaultValues`, nunca a prop controlada `values` do React Hook Form) — um refetch em
  background nunca sobrescreve uma edição em andamento. `PATCH /api/v1/properties/:id` via
  `updateProperty()` (`src/features/properties/api/update-property.ts`, hook
  `useUpdateProperty`) envia **apenas os campos que `formState.dirtyFields` marcou como
  alterados** (`pickDirtyFormFields()`) — nunca o objeto inteiro. Um campo não tocado é omitido
  do payload (o backend interpreta ausência como "não mudar"); um campo nullable que o usuário
  limpou é enviado como `null` explícito (nunca omitido por acidente); um campo numérico
  alterado para `0` envia `0` (nunca confundido com "vazio"/`null`). Salvar sem nenhuma
  alteração nunca chama `PATCH` — o botão fica desabilitado enquanto `!isDirty`. Sucesso
  atualiza o cache do detalhe (`setQueryData`) e invalida o do catálogo, depois navega para
  `/properties/:id`.
- Erro de mutation (create ou edit) mostra uma mensagem fixa e segura no próprio formulário
  ("Não foi possível salvar o imóvel.") — nunca o corpo bruto do erro; sucesso também mostra um
  toast (`sonner`, já montado globalmente em `AppProviders`).
- **Fora de escopo nesta tarefa**: upload de mídia, reorder, cover management, delete de mídia,
  delete/archive de imóvel pela UI, autenticação, tenant switcher, auto-save, optimistic
  update, persistência local de rascunho (`localStorage`/`IndexedDB`), bloqueio de navegação
  por alterações não salvas.
