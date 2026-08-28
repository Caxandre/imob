# Imob Backend

Backend de uma plataforma SaaS imobiliária multi-tenant.

Este é o projeto `backend/` dentro do repositório `imob`. O frontend é uma aplicação
independente em `frontend/`, com dependências e build próprios — não há workspace nem
packages compartilhados entre os dois. Ver o [README da raiz](../README.md).

**Todos os comandos deste documento devem ser executados a partir do diretório
`backend/`.**

Estado atual: provisioning de tenant completo (database exclusivo por tenant, real, sob
demanda) e o primeiro módulo de domínio (`properties`) implementado sobre o Tenant Data Plane
— ver [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) para o estado
completo. Autenticação ainda não existe; rotas de domínio usam um mecanismo temporário de
tenant context (`X-Tenant-Id`) enquanto isso.

## Stack

- Node.js 22 LTS + TypeScript (strict, ESM)
- Fastify
- PostgreSQL + Drizzle ORM
- Zod (validação de configuração)
- Redis + BullMQ (infraestrutura instalada; sem filas de negócio ainda)
- Pino (logging estruturado)
- OpenAPI/Swagger
- Vitest
- Docker / Docker Compose
- pnpm

## Requisitos

- Node.js `>=22.16.0` (ver `.nvmrc`)
- pnpm (via Corepack: `corepack enable`)
- Docker + Docker Compose

## Instalação

```bash
pnpm install
```

## Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste conforme necessário:

```bash
cp .env.example .env
```

| Variável                     | Descrição                                              |
| ----------------------------- | ------------------------------------------------------- |
| `NODE_ENV`                   | `development` \| `test` \| `production`                 |
| `HOST`                       | Host de bind do servidor HTTP                            |
| `PORT`                       | Porta do servidor HTTP                                   |
| `LOG_LEVEL`                  | Nível de log do Pino                                     |
| `CONTROL_PLANE_DATABASE_URL` | Connection string do banco do Control Plane               |
| `REDIS_URL`                  | Connection string do Redis                                |

A aplicação valida essas variáveis na inicialização (Zod) e falha imediatamente se algo
obrigatório estiver ausente ou inválido.

`.env` nunca é versionado.

## Docker (infraestrutura local)

```bash
docker compose up -d
```

Sobe três serviços:

- `postgres-control` — Control Plane (porta local `5434`)
- `postgres-tenants` — cluster onde databases de tenants serão provisionados no futuro (porta local `5433`)
- `redis` — para BullMQ e necessidades futuras (porta `6379`)

## Migrations (Control Plane)

O schema do Control Plane é versionado em `drizzle/control-plane/`.

```bash
pnpm db:generate   # gera uma nova migration a partir de src/.../control-plane/schema.ts
pnpm db:migrate    # aplica as migrations pendentes no Control Plane
```

Migrations **não** são aplicadas automaticamente quando a API inicia — subir a aplicação e
migrar o banco são operações independentes. Reexecutar `pnpm db:migrate` é seguro: o
Drizzle registra as migrations já aplicadas e ignora as que não estão pendentes.

## Execução local

### Desenvolvimento por componentes (topologia real de produção)

```bash
pnpm dev                      # API HTTP
pnpm dev:dispatcher           # dispatcher de provisioning
pnpm dev:provisioning-worker  # worker de provisioning
```

Três processos independentes, cada um sem acesso à memória dos outros — a mesma topologia
real usada em produção. **Limitação conhecida**: `pnpm dev` e `pnpm dev:provisioning-worker`
não compartilham `SecretStore` entre si (cada um tem sua própria instância em memória, vazia
no início) — um secret de tenant escrito pelo worker durante o provisioning não fica visível
para a API rodando neste modo. Isso é esperado até existir um `SecretStore` de produção real
(ADR-004) ou outro mecanismo de compartilhamento seguro. Neste modo, tanto a linha em
`database_clusters` quanto o secret administrativo do cluster continuam exigindo bootstrap
manual (nenhum bootstrap automático existe fora de `pnpm dev:full`, ver abaixo). Use o modo
integrado abaixo para testar rotas de domínio (`/api/v1/properties`) manualmente contra um
tenant provisionado localmente.

### Desenvolvimento integrado (só para testes manuais locais)

```bash
pnpm dev:full          # API + provisioning worker no mesmo processo, SecretStore compartilhado
pnpm dev:dispatcher     # continua processo separado
```

`pnpm dev:full` existe **somente como conveniência de desenvolvimento local**, até o
`SecretStore` de produção (ADR-004) estar implementado — não representa a topologia real e
recusa-se a iniciar sob `NODE_ENV=production`. Ver
[`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md#local-development-runtime--o-gap-de-secretstore-entre-processos)
para os detalhes completos.

Ao iniciar, `pnpm dev:full` também faz o bootstrap idempotente da linha `database_clusters`
apontada por `TENANT_DATABASE_DEFAULT_CLUSTER` e semeia o secret administrativo do cluster no
seu `SecretStore` em memória — não é mais necessário nenhum passo manual só para este modo.
Ajustável via `DEV_BOOTSTRAP_CLUSTER_HOST`/`_PORT`/`_ADMIN_USERNAME`/`_ADMIN_PASSWORD`
(opcionais — ver `.env.example`; os defaults já apontam para o serviço `postgres-tenants` do
Docker Compose).

Servidor sobe em `http://localhost:3000` (ajustável via `PORT`) em qualquer um dos dois modos.

- Health check: `GET /health`
- Documentação OpenAPI: `GET /docs`

## API documentation

A API expõe uma especificação OpenAPI 3.x e uma interface Swagger UI, geradas diretamente
dos schemas de rota do Fastify (`@fastify/swagger` + `@fastify/swagger-ui`) — o mesmo
contrato validado em runtime, nunca uma cópia mantida à mão.

1. Suba a infraestrutura local e o backend. Para exercitar só `Tenants`/`GET /health`,
   `pnpm dev` é suficiente. Para também exercitar `Properties` (que exige um tenant `READY`),
   use o modo integrado:

   ```bash
   docker compose up -d
   pnpm db:migrate
   pnpm dev:dispatcher   # outro terminal
   pnpm dev:full         # outro terminal — API + provisioning worker, SecretStore compartilhado
   ```

2. Abra no navegador:

   ```text
   http://localhost:3000/docs
   ```

   A especificação bruta (JSON) também fica disponível em `http://localhost:3000/docs/json`.

3. Use **Try it out** em qualquer rota para executar requests reais contra o servidor em
   execução — não há mock nem servidor de exemplo separado. Em particular,
   `POST /api/v1/tenants` **cria um registro real** no Control Plane apontado por
   `CONTROL_PLANE_DATABASE_URL` no seu `.env`.

### Fluxo de teste manual sugerido

```text
Swagger UI
  → Tenants → POST /api/v1/tenants → Try it out
  → preencher o payload de exemplo (name/slug)
  → Execute
  → conferir 201, com o tenant criado (status "PROVISIONING")
```

Para observar o `409 Conflict` documentado, execute o mesmo request novamente sem alterar o
`slug` — a segunda tentativa retorna `409` porque o slug já está em uso.

### Testando Properties (requer `pnpm dev:full` e um tenant READY)

```text
Swagger UI (com pnpm dev:full em execução)
  → Tenants → POST /api/v1/tenants → Try it out → Execute
  → aguardar o provisioning terminar (worker rodando no mesmo processo) — confira o log até
    "provisioning job processed"; o tenant fica READY quando o job SUCCEEDED
  → copiar o id do tenant retornado
  → Properties → POST /api/v1/properties → Try it out
    → preencher X-Tenant-Id com o id do tenant → preencher o payload de exemplo → Execute
    → conferir 201, com o property criado
  → Properties → GET /api/v1/properties → Try it out
    → preencher X-Tenant-Id com o mesmo id → Execute → conferir a listagem paginada
    → opcional: testar filtros e ordenação, ex. status=ACTIVE&property_type=APARTMENT&
      city=São Paulo&price_min=300000.00&price_max=600000.00&sort=price&order=asc
      (parâmetros desconhecidos retornam 400 — ver a descrição da rota no Swagger para a
      lista completa)
    → opcional: testar busca textual, ex. GET /properties?q=apartamento+centro (PostgreSQL
      Full Text Search sobre title/description/street/neighborhood/city — nunca ILIKE; sem
      sort explícito, resultados com q vêm ordenados por relevância)
  → Properties → GET /api/v1/properties/{id} → Try it out
    → preencher X-Tenant-Id e o id retornado pelo POST → Execute → conferir 200
  → Properties → PATCH /api/v1/properties/{id} → Try it out
    → preencher X-Tenant-Id e o id → body {"price": "475000.00", "status": "ACTIVE"}
    → Execute → conferir 200, só os campos enviados mudaram
  → Properties → DELETE /api/v1/properties/{id} → Try it out
    → preencher X-Tenant-Id e o id → Execute → conferir 204 (arquivamento, nunca exclusão
      física — GET no mesmo id continua retornando 200 com status "INACTIVE")
  → Properties → POST /api/v1/properties/{id}/media → Try it out
    → preencher X-Tenant-Id e o id de um property DRAFT/ACTIVE → escolher um arquivo
      (multipart, campo "file"; apenas image/jpeg, image/png ou image/webp, até 10MB — MIME
      validado pelo header e pelos magic bytes do arquivo, nunca só pela extensão) → Execute
      → conferir 201 (property INACTIVE retorna 409 — arquivar bloqueia novos uploads)
  → Properties → GET /api/v1/properties/{id}/media → Try it out
    → preencher X-Tenant-Id e o id → Execute → conferir a galeria (ordenada por position)
  → Properties → PUT /api/v1/properties/{id}/media/order → Try it out
    → preencher X-Tenant-Id e o id → body {"media_ids": ["<id2>", "<id1>"]} com exatamente os
      ids da galeria atual, na nova ordem → Execute → conferir 200 com a galeria reordenada
      (id desconhecido/de outra propriedade → 404; contagem não bate → 409)
  → Properties → PATCH /api/v1/properties/{id}/media/{mediaId}/cover → Try it out
    → preencher X-Tenant-Id, o id e o mediaId (sem corpo) → Execute → conferir 200 com
      "is_cover": true (repetir a mesma chamada continua retornando 200 — idempotente)
  → Properties → DELETE /api/v1/properties/{id}/media/{mediaId} → Try it out
    → preencher X-Tenant-Id, o id e o mediaId (sem corpo) → Execute → conferir 204; GET na
      galeria mostra as posições restantes reindexadas sem buracos, e — se a mídia removida era
      a capa — a nova posição 0 vira a nova capa automaticamente
```

`X-Tenant-Id` é **temporário** — um mecanismo de desenvolvimento/integração enquanto
autenticação real não existe, não uma decisão definitiva de produto (ver
[`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)). Qualquer cliente
que conheça um `tenantId` pode informá-lo; isso não é autenticação.

Sem `pnpm dev:full` (ou seja, com `pnpm dev` sozinho), `POST/GET /api/v1/properties` contra um
tenant provisionado pelo worker separado falha ao resolver a credencial do tenant — ver a
seção "Local development runtime" em `ARCHITECTURE.md`.

Rotas documentadas hoje: `GET /health` (tag **System**), `POST /api/v1/tenants` (tag
**Tenants**), e `POST/GET /api/v1/properties`, `GET/PATCH/DELETE /api/v1/properties/{id}`,
`POST/GET /api/v1/properties/{id}/media`, `PUT /api/v1/properties/{id}/media/order`,
`PATCH /api/v1/properties/{id}/media/{mediaId}/cover`,
`DELETE /api/v1/properties/{id}/media/{mediaId}` (tag **Properties**) — `DELETE /properties/{id}`
arquiva (`status = INACTIVE`), nunca exclui fisicamente; `DELETE .../media/{mediaId}` remove
fisicamente um único item da galeria (metadata primeiro, objeto no R2 depois, best-effort — ver
[ADR-007](docs/architecture/adr/ADR-007-property-media-consistency.md)). As três rotas de
galeria (reorder/capa/exclusão) continuam permitidas mesmo com a propriedade arquivada — só o
upload de mídia nova é bloqueado por arquivamento. Nenhuma rota interna de worker/dispatcher/
provisioning é exposta aqui — o Swagger descreve apenas a interface HTTP pública.

## Cloudflare R2 (object storage)

Provider escolhido para armazenar objetos binários (fotos de imóveis e outros arquivos) fora do
PostgreSQL — ver [ADR-006](docs/architecture/adr/ADR-006-cloudflare-r2-object-storage.md).
Consumido através da porta `ObjectStorage`
(`src/infrastructure/object-storage/object-storage.ts`); o adapter real
(`createCloudflareR2ObjectStorage`, `src/infrastructure/object-storage/cloudflare-r2-object-storage.ts`)
usa `@aws-sdk/client-s3` contra a API S3-compatível do R2.

Env vars (ver `.env.example`) — todas opcionais no parse global (nenhum outro processo além de
`pnpm dev`/`pnpm start` exige storage para subir), mas exigidas como conjunto completo desde o
startup de `pnpm dev:full`/`pnpm start` (Prompt 027: essas rotas registram upload de mídia,
então R2 incompleto faz o servidor recusar-se a subir, nunca falhar só no primeiro upload):

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_PUBLIC_URL
```

- O bucket referenciado por `R2_BUCKET` já deve existir — este código nunca cria um bucket.
- **Nunca** commitar credenciais reais. `.env` já está no `.gitignore`; `.env.example` nunca
  deve conter valores reais, só os nomes das variáveis.
- Desde o Prompt 027, `POST /api/v1/properties/{id}/media` é o consumidor real — ver a seção
  "Testando Properties" acima.
- Processamento assíncrono de imagem (thumbnails/variantes via `sharp` + BullMQ) tem sua
  arquitetura definida em
  [ADR-008](docs/architecture/adr/ADR-008-asynchronous-property-image-processing.md) — ainda
  **não implementado** (nenhuma variante é gerada hoje).

Teste de integração real (opcional, nunca roda em CI): ver
`src/infrastructure/object-storage/cloudflare-r2-object-storage.integration.test.ts` —
exige `RUN_R2_INTEGRATION_TESTS=true` **e** todas as `R2_*` configuradas.

## Build e produção

```bash
pnpm build
pnpm start
```

## Comandos disponíveis

| Comando           | Descrição                                  |
| ------------------ | -------------------------------------------- |
| `pnpm dev`         | Sobe a API em modo desenvolvimento (watch)   |
| `pnpm dev:full`    | DEV-ONLY: API + provisioning worker no mesmo processo, SecretStore compartilhado |
| `pnpm dev:dispatcher` | Sobe o dispatcher de provisioning (watch)  |
| `pnpm dev:provisioning-worker` | Sobe o worker de provisioning isolado (watch) |
| `pnpm db:generate` | Gera migration a partir do schema do Control Plane |
| `pnpm db:migrate`  | Aplica migrations pendentes do Control Plane |
| `pnpm tenant-db:generate` | Gera migration a partir do schema do Tenant Data Plane |
| `pnpm build`       | Compila TypeScript para `dist/`              |
| `pnpm start`       | Executa o build de produção                  |
| `pnpm typecheck`   | Verifica tipos sem gerar output              |
| `pnpm lint`        | Executa o ESLint                             |
| `pnpm format`      | Formata o código com Prettier                |
| `pnpm test`        | Executa a suíte de testes (Vitest)           |

## Testes

```bash
docker compose up -d postgres-control   # pré-requisito dos testes de persistência
pnpm test
```

- Os testes de integração HTTP usam `Fastify.inject()` — nenhuma porta de rede real é aberta.
- Os testes de persistência do Control Plane **exigem o serviço `postgres-control` no ar**.
  Eles nunca usam o banco de desenvolvimento: antes da suíte rodar, `test/global-setup.ts`
  recria do zero um banco dedicado (`imob_control_test`, no mesmo servidor) e aplica todas
  as migrations nele. Assim cada execução também valida o caminho
  "banco vazio → migrations → schema completo".

Para apontar os testes a outro servidor PostgreSQL, defina
`CONTROL_PLANE_TEST_DATABASE_URL`.

## Architecture

Documentação completa em [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)
e decisões em [`docs/architecture/adr/`](docs/architecture/adr/).

Resumo:

- **Backend e frontend são aplicações independentes**, sem workspace e sem packages
  compartilhados, versionadas no mesmo repositório Git.
- **Monólito modular**: API HTTP e workers vivem no mesmo projeto, com entrypoints
  independentes de produção (`server.ts`, `provisioning-worker.ts`,
  `provisioning-dispatcher.ts`) mais um runtime combinado só de desenvolvimento
  (`dev-full.ts`, ver "Execução local" acima).
- **Control Plane**: banco PostgreSQL central com dados globais do SaaS. O schema inicial já
  existe, com as tabelas `tenants`, `database_clusters`, `tenant_databases` e
  `provisioning_jobs`. Planos e billing ainda não possuem tabelas.
- **Tenant Data Plane**: cada tenant possui seu próprio database PostgreSQL exclusivo,
  provisionado sob demanda de forma real e assíncrona (`tenants` → `provisioning_jobs` →
  dispatcher → BullMQ → worker). Primeiro módulo de domínio (`properties`) já implementado
  sobre esse schema.
- O código de domínio nunca assume que todos os tenants compartilham o mesmo database.
