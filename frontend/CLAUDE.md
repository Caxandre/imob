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
  manualmente campo a campo para formulários reais. Formulários de criação/edição de imóvel
  devem usar React Hook Form + Zod; o payload da requisição deve ser derivado dos valores
  validados do formulário (o _output_ do schema Zod via `zodResolver`), nunca parsing ad hoc
  local no componente. Ver `PropertyForm`/`property-form.schema.ts` (Prompt 040) como exemplo
  aplicado.
- **Estado navegável/compartilhável** (filtros, paginação, o que devia sobreviver a um reload ou
  a compartilhar um link) pertence à **URL** (query string/params via React Router) — nunca só
  em memória se o usuário esperaria que um link copiado reproduzisse o mesmo estado.
- **Estado de UI local** (aberto/fechado, hover, um passo de wizard) permanece local
  (`useState`/`useReducer`) — não promova para algo global sem necessidade real. A seleção
  ativa de uma galeria de mídia (ex.: `PropertyGallery`) é exatamente esse caso: `useState`
  local, nunca promovida para URL/TanStack Query/Zustand. Ver
  `src/features/properties/components/PropertyGallery.tsx` (Prompt 038) como exemplo aplicado.
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
- Feature de Tenant Data Plane (ex.: Properties) deve passar o contexto de tenant
  explicitamente, sempre escopado à própria chamada de API da feature — nunca injetar
  `X-Tenant-Id` globalmente em `apiFetch()`. Control Plane e Tenant Data Plane são contextos
  diferentes (ver `backend/CLAUDE.md`/`ARCHITECTURE.md`); nada que só o Tenant Data Plane usa
  pertence à camada HTTP genérica. Ver `src/features/properties/api/list-properties.ts` como
  exemplo aplicado (Prompt 037B).
- Filtros, ordenação e paginação de um catálogo compartilhável (ex.: `/properties`) pertencem à
  URL, não a estado local/global — um link copiado deve reproduzir o mesmo resultado. Ver
  `src/features/properties/schemas/property-filters.schema.ts` (Prompt 037B) como exemplo
  aplicado: parsing tolerante (valor inválido é ignorado, nunca quebra a página) e serialização
  que omite parâmetros vazios/default.
- Uma página de detalhe de imóvel (ex.: `/properties/:id`) pode carregar o imóvel e sua galeria
  de mídia em paralelo, mas nunca deve fazer requisições adicionais de storage ou por item de
  mídia — toda URL de exibição (thumbnail/card/detail/original) já vem embutida na resposta da
  API de mídia da propriedade. Ver `PropertyDetailsPage`/`usePropertyMedia` (Prompt 038) como
  exemplo aplicado: exatamente uma chamada `GET /properties/:id` e uma
  `GET /properties/:id/media` por carregamento, nunca uma por item de mídia.
- Mutations de PATCH em imóvel devem preservar a semântica de atualização parcial do backend e
  nunca sobrescrever campos nullable que não foram tocados: envie somente os campos que
  `formState.dirtyFields` marcou como alterados (nunca o objeto inteiro do formulário), omita
  por completo um campo não tocado, e envie `null` explícito para um campo nullable que o
  usuário realmente limpou. Ver `pickDirtyFormFields()`/`useUpdateProperty` (Prompt 040) como
  exemplo aplicado.
- Mutations de mídia de imóvel devem usar exclusivamente a API de mídia do backend — o frontend
  nunca faz upload direto ao R2 (ou a qualquer object storage), nunca instala um SDK de storage,
  e nunca deriva/constrói uma object key. Toda URL de exibição já vem pronta na resposta da API.
  Ver `uploadPropertyMedia()`/`PropertyMediaManager` (Prompt 041) como exemplo aplicado.
- Conclusão do upload HTTP de uma mídia e conclusão do processamento assíncrono dessa mídia são
  estados diferentes — a UI deve representar `PROCESSING`/`READY`/`FAILED` explicitamente (nunca
  tratar "upload terminou" como "variantes prontas", nunca marcar `PROCESSING` como falho por
  timeout no frontend — o backend é a autoridade do status). Ver `PropertyMediaManagerItem`
  (Prompt 041) como exemplo aplicado.
- Polling de mídia em processamento só é permitido enquanto a galeria do imóvel atual
  efetivamente contiver algum item `PROCESSING`, e deve parar sozinho assim que o processamento
  se estabilizar — via `refetchInterval` do TanStack Query, nunca um `setInterval` manual. Ver
  `usePropertyMedia` (Prompt 041) como exemplo aplicado.
- Reorder de galeria deve preservar a semântica de conjunto exato do backend (`media_ids` precisa
  conter todos os ids atuais, nunca um subconjunto) e não deve introduzir dependência de
  drag-and-drop (`dnd-kit`, `react-beautiful-dnd`, `sortablejs`, ...) sem uma decisão
  arquitetural explícita — a UX atual usa botões mover-para-esquerda/direita, acessíveis via
  teclado. Ver `PropertyMediaManager` (Prompt 041) como exemplo aplicado.
- Exclusão de imóvel no frontend deve preservar a semântica de arquivamento (soft-archive) do
  backend. `DELETE /properties/:id` significa arquivar (`status = INACTIVE`), nunca exclusão
  permanente — a UI nunca deve implementar/sugerir "excluir definitivamente"/purge/hard delete.
  Ver `archiveProperty()`/`PropertyLifecycleActions` (Prompt 042) como exemplo aplicado.
- Transições de ciclo de vida de um recurso de domínio (ex.: status do imóvel) devem ser
  representadas como ações explícitas ("Ativar imóvel", "Arquivar imóvel", "Reativar imóvel"),
  nunca inferidas de uma mutação genérica de status no cliente (ex.: um `<select>` de status
  cru) — cada ação mapeia para exatamente uma chamada HTTP com semântica clara. Ver
  `PropertyLifecycleActions` (Prompt 042) como exemplo aplicado.
- O backend continua sendo a fonte de verdade sobre quais transições de ciclo de vida são
  permitidas — o frontend nunca reimplementa regra de transição própria nem assume que uma
  transição é bloqueada sem o backend ter confirmado isso (ex.: nenhuma mensagem de erro
  específica para "transição inválida" foi inventada onde o backend não distingue esse caso).
  Ver `PropertyLifecycleActions` (Prompt 042) como exemplo aplicado.

## Componentes shadcn

- Não adicione um novo componente shadcn (`pnpm dlx shadcn@latest add ...`) só porque pode ser
  útil depois — adicione quando uma tarefa realmente for usá-lo.

## Processo

- Mudanças funcionais seguem o mesmo fluxo do backend: uma branch, um PR, CI verde, aprovação
  humana antes do merge — nunca commit direto em `main`, nunca merge sem aprovação explícita.
