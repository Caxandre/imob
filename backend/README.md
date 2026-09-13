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
- Redis + BullMQ (fila `tenant-provisioning`, fila `media-processing`)
- Sharp (geração de variantes de imagem — thumbnail/card/detail)
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
| `CORS_ALLOWED_ORIGINS`       | Lista de origens de browser autorizadas (ver seção CORS abaixo) |
| `DEV_SECRET_STORE_PATH`      | Caminho do arquivo local de secrets de desenvolvimento (ver seção abaixo) |

A aplicação valida essas variáveis na inicialização (Zod) e falha imediatamente se algo
obrigatório estiver ausente ou inválido.

`.env` nunca é versionado.

## CORS

A API usa `@fastify/cors` (registrado dentro de `buildApp()`, então vale tanto para o servidor
real quanto para os testes HTTP via `Fastify.inject()`) com uma allowlist explícita de origens
de browser, configurada por `CORS_ALLOWED_ORIGINS`:

```env
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

Múltiplas origens, separadas por vírgula:

```env
CORS_ALLOWED_ORIGINS=http://localhost:5173,https://app.example.com,https://admin.example.com
```

Comportamento:

- **Match exato**: `http://localhost:5173` autoriza exatamente essa origem — não
  `http://localhost:5174`, não `https://localhost:5173`, não um subdomínio.
- **Sem wildcard**: `origin: "*"` e o equivalente a `origin: true` (refletir qualquer origem)
  nunca são usados, nem como default de desenvolvimento — uma allowlist vazia significa que
  nenhuma origem de browser é autorizada, não "permitir tudo" (a API continua subindo
  normalmente mesmo assim).
- **Sem credentials**: `Access-Control-Allow-Credentials` nunca é enviado — não existe
  autenticação baseada em cookie/sessão de browser ainda.
- **Preflight**: `OPTIONS` é respondido automaticamente pelo plugin para qualquer rota (nunca
  uma rota `OPTIONS` manual por endpoint), incluindo o header customizado `X-Tenant-Id` que o
  Tenant Data Plane usa — o preflight reflete os headers realmente solicitados pelo browser em
  vez de uma allowlist fixa de headers, mas só para uma origem já autorizada.
- **Requests sem `Origin`** (curl, chamada server-to-server, testes, workers) nunca são
  bloqueadas por isso — CORS é uma política aplicada pelo browser, não autenticação.
- Cada entrada é validada como URL http/https absoluta (sem path/query/fragment) na
  inicialização — `localhost:5173` ou `http://localhost:5173/app` falham explicitamente,
  em vez de serem aceitas silenciosamente. Uma barra final é normalizada para a origem canônica
  (`http://localhost:5173/` vira `http://localhost:5173`), e duplicatas são removidas.

## SecretStore local (desenvolvimento)

Credenciais de banco de tenant/cluster (`SecretStore`, ADR-003/ADR-004) são resolvidas por
referência (`secretReference` → `{ username, password }`) — nunca persistidas no Control Plane.
Em desenvolvimento, isso é um `LocalFileSecretStore` (Prompt 039): um arquivo JSON local,
gitignored, criado automaticamente na primeira escrita.

```env
DEV_SECRET_STORE_PATH=.local/secrets.json
```

- **Persiste entre restarts**: reiniciar `pnpm dev:full` (ou qualquer entrypoint) não perde mais
  a credencial de um tenant já provisionado — o mesmo `tenantId` continua funcionando.
- **Compartilhado entre processos locais**: `server.ts`, `dev-full.ts`,
  `provisioning-worker.ts`, `media-outbox-dispatcher.ts` e `media-processing-worker.ts` resolvem
  o caminho a partir da mesma env var — apontando todos para o mesmo arquivo (o default já faz
  isso), uma credencial escrita por um processo é lida por outro, sem precisar de
  `pnpm dev:full` para "juntar" tudo em um processo só.
- **Nunca em produção**: sob `NODE_ENV=production`, a fábrica que decide o provider
  (`createRuntimeSecretStore()`) sempre falha explicitamente — nenhum fallback para arquivo ou
  para o `InMemorySecretStore` de teste. Nenhum provider de produção existe ainda (ADR-004,
  status `PLANNED`).
- **Nunca commitado, nunca logado**: o caminho é relativo à raiz do `backend/` (não ao diretório
  de onde o processo foi iniciado). Este README nunca mostra o conteúdo do arquivo — apenas o
  caminho de configuração.
- **Plaintext, e isso é aceitável aqui**: é um arquivo de desenvolvimento, na sua própria
  máquina — não é criptografado (criptografar ao lado de uma chave guardada no mesmo lugar não
  adicionaria segurança real). Nunca use este mecanismo como modelo para produção.
- **Tenants antigos**: um tenant cujo secret já foi perdido por uma execução anterior do
  `InMemorySecretStore` (antes deste Prompt) não é recuperável magicamente — ele precisa ser
  reprovisionado uma última vez. A partir daí, com `LocalFileSecretStore`, isso não volta a
  acontecer.

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
pnpm dev:media-dispatcher     # dispatcher de outbox de mídia
pnpm dev:media-worker         # worker de processamento de imagens (sharp)
```

Cinco processos independentes, cada um sem acesso à memória dos outros — a mesma topologia
real usada em produção. **Limitação conhecida**: `pnpm dev`, `pnpm dev:provisioning-worker`,
`pnpm dev:media-dispatcher` e `pnpm dev:media-worker` não compartilham `SecretStore` entre si
(cada um tem sua própria instância em memória, vazia no início) — um secret de tenant escrito
pelo worker de provisioning durante o provisioning não fica visível para a API, para o
dispatcher de outbox de mídia, nem para o worker de processamento de imagens rodando neste
modo (os três últimos precisam resolver a credencial de aplicação de cada tenant para abrir seu
Tenant Data Plane). `pnpm dev:dispatcher` (o dispatcher de *provisioning*) é a única exceção —
ele só toca Control Plane + Redis, nunca uma credencial de tenant, então não tem esse problema.
Isso é esperado até existir um `SecretStore` de produção real (ADR-004) ou outro mecanismo de
compartilhamento seguro. Neste modo, tanto a linha em `database_clusters` quanto o secret
administrativo do cluster continuam exigindo bootstrap manual (nenhum bootstrap automático
existe fora de `pnpm dev:full`, ver abaixo). Use o modo integrado abaixo para testar rotas de
domínio (`/api/v1/properties`) manualmente contra um tenant provisionado localmente, incluindo
o processamento real de mídia.

### Desenvolvimento integrado (só para testes manuais locais)

```bash
pnpm dev:full          # API + provisioning worker + media outbox dispatcher +
                        # media processing worker, todos no mesmo processo,
                        # SecretStore compartilhado
pnpm dev:dispatcher     # continua processo separado (nunca precisa de SecretStore)
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

Use **Tenants → GET /api/v1/tenants** para listar os tenants já criados (paginado; filtros
opcionais `status`, `q` — substring case-insensitive sobre `name`/`slug`). Cada item traz um
resumo do database/cluster associado (`database: null` enquanto o provisionamento não terminou).
É uma rota administrativa do Control Plane, sem autenticação implementada ainda (ver
`ARCHITECTURE.md`) — nunca consulta o database de nenhum tenant.

Use **Tenants → GET /api/v1/tenants/{id}** para o detalhe operacional de um único tenant —
returns Control Plane operational details for one tenant: o tenant, seu database/cluster
(com timestamps, diferente da listagem) e seu `latestProvisioningJob` (o mais recente por
`created_at DESC, id DESC`). `database`/`latestProvisioningJob` são `null` quando ainda não
existem — nunca 404 por causa disso; só um `id` inexistente retorna 404. Mesma rota
administrativa do Control Plane, mesma ausência de autenticação.

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
    → cada item traz "cover": um resumo da mídia de capa (thumbnail/card, nunca detail) —
      null enquanto a mídia ainda não existe ou não terminou de processar (ver "Cover media
      na listagem" abaixo)
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
    → preencher X-Tenant-Id e o id → Execute → conferir a galeria (ordenada por position),
      cada item com "variants": {"thumbnail": ..., "card": ..., "detail": ...} — null em cada
      chave até a variante correspondente existir (ver parágrafo abaixo)
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
      a capa — a nova posição 0 vira a nova capa automaticamente (original e toda variante já
      gerada são removidos do R2 também, best-effort, após o commit — ver ADR-007 "Delete")
```

Logo após o upload, `GET .../media` mostra `"processing_status": "PROCESSING"` e
`"variants": {"thumbnail": null, "card": null, "detail": null}`. Com `pnpm dev:full` (que já
inclui o dispatcher de outbox de mídia e o worker de processamento — ver acima), em poucos
segundos o mesmo `GET` deve mostrar `"processing_status": "READY"` com as três variantes
preenchidas (`THUMBNAIL`/`CARD`/`DETAIL`, WebP), cada uma com `url`/`mime_type`/`width`/
`height`/`size_bytes` — nunca `object_key`. Um original que o `sharp` não consegue decodificar
(ou que excede o limite de pixels configurado) termina como `"processing_status": "FAILED"`
com as três variantes `null`, em vez de `"READY"` — nunca fica preso em `"PROCESSING"`
indefinidamente. Uma mídia migrada pelo Prompt 030 (antes de o worker existir) pode ficar
`"READY"` sem nenhuma variante — a API nunca assume que `READY` garante variantes para essas
mídias legadas, e nunca falha com 500 por causa disso.

`X-Tenant-Id` é **temporário** — um mecanismo de desenvolvimento/integração enquanto
autenticação real não existe, não uma decisão definitiva de produto (ver
[`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)). Qualquer cliente
que conheça um `tenantId` pode informá-lo; isso não é autenticação.

Antes do Prompt 039 (`InMemorySecretStore`), `POST/GET /api/v1/properties` contra um tenant
provisionado por um processo separado (worker rodando sozinho, sem `dev:full`) falhava ao
resolver a credencial do tenant — ver "Local development runtime" em `ARCHITECTURE.md`. Desde o
Prompt 039, isso deixou de ser necessariamente verdade: `server.ts`, `provisioning-worker.ts`,
`media-outbox-dispatcher.ts` e `media-processing-worker.ts`, mesmo rodando como processos
completamente separados, compartilham o mesmo `LocalFileSecretStore` (ver seção "SecretStore
local" acima) — desde que todos apontem para o mesmo `DEV_SECRET_STORE_PATH` (o default já
garante isso). `pnpm dev:full` continua sendo a forma mais simples (um terminal em vez de
quatro), não a única forma de compartilhar secrets localmente.

**Troubleshooting: `503 { "message": "Tenant infrastructure is not currently available" }`.**
Antes do Prompt 039, isso acontecia sempre que `pnpm dev:full` reiniciava (nova sessão, crash,
`--watch` recarregando) — o `SecretStore` em memória não sobrevivia ao restart, e qualquer
tenant provisionado por uma execução *anterior* ficava permanentemente inutilizável naquele
processo, mesmo continuando `READY` no Control Plane. **Desde o Prompt 039, isso não acontece
mais** para tenants provisionados com o `LocalFileSecretStore` — o mesmo `tenantId` continua
funcionando após um restart, porque a credencial está persistida em
`DEV_SECRET_STORE_PATH`, não na memória do processo. Se você ainda vir esse erro:

- confirme que `DEV_SECRET_STORE_PATH` é o mesmo em todos os processos envolvidos (o default já
  garante isso, a menos que tenha sido customizado de forma inconsistente);
- se o tenant foi provisionado *antes* de adotar este Prompt (secret já perdido pelo
  `InMemorySecretStore` antigo), ele não é recuperável magicamente — reprovisione-o uma última
  vez (`POST /api/v1/tenants`, aguardar `READY`) e passe a usar esse novo id.

### Testando Leads (requer `pnpm dev:full` e um tenant READY)

```text
Swagger UI (com pnpm dev:full em execução, ou apenas pnpm dev — Leads não depende de fila)
  → Leads → POST /api/v1/leads → Try it out
    → preencher X-Tenant-Id com o id de um tenant READY → preencher o payload de exemplo
      (name + email e/ou phone; property_id opcional) → Execute
    → conferir 201, sempre com "status": "NEW" (o campo não pode ser enviado no create) e
      "source": "MANUAL" por padrão
    → remover email e phone do payload e tentar novamente → conferir 400 (nenhum canal de
      contato)
  → Leads → GET /api/v1/leads → Try it out
    → preencher X-Tenant-Id → Execute → conferir a listagem paginada
    → cada item traz "property": um resumo {id, title, status} do imóvel associado, ou null
      quando o lead não tem property_id — carregado com um único JOIN, nunca uma consulta por
      lead
    → opcional: testar filtros, ex. status=NEW&source=WEBSITE&q=maria&
      created_from=2026-01-01T00:00:00Z&created_to=2026-12-31T23:59:59Z&sort=name&order=asc
      (parâmetro desconhecido retorna 400)
  → Leads → GET /api/v1/leads/{id} → Try it out
    → preencher X-Tenant-Id e o id retornado pelo POST → Execute → conferir 200, com o mesmo
      resumo "property" do item de listagem
  → Leads → PATCH /api/v1/leads/{id} → Try it out
    → preencher X-Tenant-Id e o id → body {"status": "CONTACTED"} → Execute → conferir 200,
      só o campo enviado mudou
    → se o lead só tem email (sem phone), tentar body {"email": null} → conferir 400 (o
      resultado ficaria sem nenhum canal de contato) e o lead permanece intacto
    → body com property_id de um imóvel inexistente neste tenant → conferir 404
```

`X-Tenant-Id` é o mesmo mecanismo temporário de desenvolvimento já usado por Properties — ver
o aviso na seção anterior. Leads é um módulo inteiramente síncrono: nenhuma escrita passa por
Redis/BullMQ/outbox, então `pnpm dev` sozinho já é suficiente para testá-lo manualmente
(`pnpm dev:full` só é necessário se você também quiser exercitar o provisioning de um tenant
novo no mesmo terminal).

Rotas documentadas hoje: `GET /health` (tag **System**), `POST/GET /api/v1/tenants` e
`GET /api/v1/tenants/{id}` (tag **Tenants** — ambos `GET` são administrativos, só o Control
Plane, sem autenticação ainda; ver `ARCHITECTURE.md`), `POST/GET /api/v1/properties`,
`GET/PATCH/DELETE /api/v1/properties/{id}`,
`POST/GET /api/v1/properties/{id}/media`, `PUT /api/v1/properties/{id}/media/order`,
`PATCH /api/v1/properties/{id}/media/{mediaId}/cover`,
`DELETE /api/v1/properties/{id}/media/{mediaId}` (tag **Properties**) — `DELETE /properties/{id}`
arquiva (`status = INACTIVE`), nunca exclui fisicamente; `DELETE .../media/{mediaId}` remove
fisicamente um único item da galeria (metadata primeiro, objeto no R2 depois, best-effort — ver
[ADR-007](docs/architecture/adr/ADR-007-property-media-consistency.md)). As três rotas de
galeria (reorder/capa/exclusão) continuam permitidas mesmo com a propriedade arquivada — só o
upload de mídia nova é bloqueado por arquivamento. E `POST/GET /api/v1/leads`,
`GET/PATCH /api/v1/leads/{id}` (tag **Leads**) — sem `DELETE`, sem fila, `status` sempre `NEW`
no create e livre para qualquer valor via `PATCH` (sem máquina de estado); um lead precisa de
pelo menos `email` ou `phone`, sempre validado contra o estado resultante, nunca só o payload
parcial enviado. Nenhuma rota interna de worker/dispatcher/provisioning é exposta aqui — o
Swagger descreve apenas a interface HTTP pública.

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
- Processamento assíncrono de imagem (thumbnails/variantes via `sharp` + BullMQ) está
  **implementado** — ver
  [ADR-008](docs/architecture/adr/ADR-008-asynchronous-property-image-processing.md) e
  [ADR-009](docs/architecture/adr/ADR-009-multi-tenant-outbox-dispatch.md) para a arquitetura
  completa. Toda mídia enviada gera automaticamente as variantes `THUMBNAIL`/`CARD`/`DETAIL`
  (WebP) no mesmo bucket R2 do original, via `pnpm dev:media-dispatcher` +
  `pnpm dev:media-worker` (ou `pnpm dev:full`, que já inclui os dois) — desde o Prompt 035, as
  três variantes são expostas em toda resposta HTTP que carrega uma mídia (`variants.thumbnail`/
  `variants.card`/`variants.detail`, cada uma `null` até existir; nunca `object_key`).
- Desde o Prompt 037A, `GET /api/v1/properties` (listagem) inclui um `cover` resumido por
  imóvel — apenas `thumbnail`/`card` (nunca `detail`, que a listagem não precisa), selecionado
  preferindo `is_cover=true` e caindo de volta para a mídia de menor `position` quando nenhuma
  está marcada como capa. `cover: null` quando o imóvel ainda não tem mídia. Carregado com um
  número fixo de queries por página (nunca N+1) e sem nenhuma chamada ao R2 durante a leitura —
  só os outros endpoints de Properties (`GET .../{id}`, `PATCH`, `DELETE`) permanecem sem
  `cover`, que é exclusivo da listagem.

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
| `pnpm dev:full`    | DEV-ONLY: API + provisioning worker + media outbox dispatcher + media processing worker no mesmo processo, SecretStore compartilhado |
| `pnpm dev:dispatcher` | Sobe o dispatcher de provisioning (watch)  |
| `pnpm dev:provisioning-worker` | Sobe o worker de provisioning isolado (watch) |
| `pnpm dev:media-dispatcher` | Sobe o dispatcher de outbox de mídia isolado (watch) |
| `pnpm dev:media-worker` | Sobe o worker de processamento de imagens (`sharp`) isolado (watch) |
| `pnpm db:generate` | Gera migration a partir do schema do Control Plane |
| `pnpm db:migrate`  | Aplica migrations pendentes do Control Plane |
| `pnpm tenant-db:generate` | Gera migration a partir do schema do Tenant Data Plane |
| `pnpm build`       | Compila TypeScript para `dist/`              |
| `pnpm start`       | Executa o build de produção                  |
| `pnpm start:dispatcher` | Executa o build de produção do dispatcher de provisioning |
| `pnpm start:provisioning-worker` | Executa o build de produção do worker de provisioning |
| `pnpm start:media-dispatcher` | Executa o build de produção do dispatcher de outbox de mídia |
| `pnpm start:media-worker` | Executa o build de produção do worker de processamento de imagens |
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
  dispatcher → BullMQ → worker). Módulos de domínio já implementados sobre esse schema:
  `properties` e `leads` (fundação síncrona, sem fila, com associação opcional a uma property).
- O código de domínio nunca assume que todos os tenants compartilham o mesmo database.
