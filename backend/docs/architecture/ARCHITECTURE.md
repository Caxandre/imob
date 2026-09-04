# Architecture

Este documento descreve a arquitetura decidida para o backend da plataforma SaaS
imobiliária. Itens marcados como **(futuro)** ainda não foram implementados — estão aqui
para orientar decisões futuras, não para descrever o estado atual do código.

## Visão geral

```text
imob/
├── backend/    (este projeto)
└── frontend/   (aplicação independente, ainda não inicializada)
```

Backend e frontend são aplicações independentes — dependências, build e testes próprios,
sem workspace e sem packages compartilhados — versionadas em um único repositório Git.

O backend é um **monólito modular**, não um conjunto de microserviços. API HTTP e workers
compartilham o mesmo código-base, mas possuem entrypoints e responsabilidades independentes.

- API HTTP: implementada (`src/main/server.ts`). Documentação OpenAPI 3.x/Swagger UI em
  `GET /docs` (JSON bruto em `GET /docs/json`), gerada a partir dos schemas de rota do
  Fastify (`@fastify/swagger`/`@fastify/swagger-ui`) — nunca um contrato mantido à parte.
  Disponível sem restrição de ambiente nesta fase (nenhuma autenticação própria para
  `/docs`); revisitar antes de um deploy de produção real.
- Workers: dois entrypoints não-HTTP implementados, cada um com scripts próprios e nenhum
  iniciado automaticamente pela API ou entre si — `src/workers/provisioning-dispatcher.ts`
  (`pnpm dev:dispatcher` / `pnpm start:dispatcher`) e `src/workers/provisioning-worker.ts`
  (`pnpm dev:provisioning-worker` / `pnpm start:provisioning-worker`, hoje recusando-se a
  iniciar — ver seção Control Plane).

## Control Plane

Banco PostgreSQL central responsável pela operação global do SaaS: tenants, planos,
assinaturas, billing, clusters de database, databases de tenants, jobs de provisioning.

**IMPLEMENTED** — schema inicial e migrations
(`src/infrastructure/database/control-plane/schema.ts`,
`drizzle/control-plane/`):

- `tenants` — identidade do tenant (`slug` único, `status`).
- `database_clusters` — clusters PostgreSQL disponíveis, com `provider`/`region`,
  `host`/`port` (metadata de conexão administrativa — nunca uma connection string completa)
  e uma `secret_reference` (ponteiro para a credencial, nunca a credencial em si).
- `tenant_databases` — qual database de qual cluster pertence a cada tenant. Um tenant
  possui no máximo um database (unicidade em `tenant_id`); `database_name` é único apenas
  dentro do mesmo cluster.
- `provisioning_jobs` — rastreabilidade do processo de provisionamento. Não substitui o
  BullMQ; é registro histórico, não fila.

Migrations são aplicadas por um comando explícito (`pnpm db:migrate`), nunca na
inicialização da API.

**IMPLEMENTED** — criação de tenant + intenção de provisionamento (`src/modules/tenants/`):

```text
POST /api/v1/tenants
    ↓
transaction (Control Plane)
    ├── insert tenants           (status PROVISIONING)
    └── insert provisioning_jobs (type CREATE_DATABASE, status PENDING)
```

As duas escritas ocorrem na mesma transação PostgreSQL: nunca existe um tenant sem a
intenção de provisionamento persistida junto, e uma falha em qualquer uma delas desfaz as
duas (`rollback`). A transação contém somente essas duas operações — nenhuma chamada a
Redis, BullMQ ou serviço externo ocorre dentro dela. O endpoint termina na persistência:
nenhum database é criado e nenhum job é efetivamente executado ou publicado em fila.

`provisioning_jobs` é o estado persistente e a fonte de auditoria do workflow de
provisionamento — não é uma fila e não será substituída pelo BullMQ como fonte de verdade;
o BullMQ (quando implementado) apenas dispara execução a partir do que já está registrado
aqui.

**IMPLEMENTED (documentation)** — a arquitetura de entrega confiável entre o Control Plane e
o BullMQ está decidida em [ADR-002](adr/ADR-002-provisioning-dispatcher.md):

```text
provisioning_jobs (PostgreSQL, fonte de verdade)
        ↓
dispatcher persistente (polling, idempotente, sem estado em memória)
        ↓
BullMQ (jobId = provisioning_jobs.id)
        ↓
worker
```

**IMPLEMENTED** — schema do protocolo de dispatch em `provisioning_jobs`: as colunas
`dispatch_claimed_at`, `dispatch_lease_until` e `dispatched_at` (todas nullable, sem
default), a constraint que impede um lease sem claim, e um índice parcial sobre jobs
`PENDING` ainda não confirmados como despachados.

**IMPLEMENTED** — dispatcher (`src/workers/provisioning-dispatcher.ts`,
`src/modules/provisioning/`) e queue BullMQ (`src/infrastructure/queue/`):

```text
poll PostgreSQL (loop próprio, sem scheduler externo)
    ↓
claim + lease (transação curta, FOR UPDATE SKIP LOCKED)
    ↓
COMMIT
    ↓
queue.add() — fila "tenant-provisioning", jobId = provisioning_jobs.id
    ↓
sucesso → dispatched_at        falha → libera o lease
```

Entrypoint independente da API (`pnpm dev:dispatcher` / `pnpm start:dispatcher`), nunca
iniciado automaticamente pelo processo HTTP. O dispatcher só escreve as três colunas de
dispatch — nunca `status`, `attempts` ou `current_step`, que continuam sendo
responsabilidade exclusiva do worker.

**IMPLEMENTED** — worker de provisionamento, máquina de estado e finalização transacional
(`src/workers/provisioning-worker.ts`, `src/modules/provisioning/`):

```text
BullMQ job (provision-tenant)
    ↓
processProvisioningJob (use case)
    ↓
findById — PostgreSQL é sempre consultado antes de agir, nunca o estado do BullMQ
    ↓
PENDING → RUNNING (UPDATE ... WHERE status='PENDING' — a escrita é a própria arbitragem)
    attempts += 1, started_at = now(), current_step = PROVISION_DATABASE
    ↓
DatabaseProvisioner.provision() — real (Prompt 017), infraestrutura externa
    ↓
falha de provisioning → FAILED, finished_at, error_message (nenhuma finalização é tentada)
    ↓
sucesso → ProvisioningResult
    ↓
repository.finalizeProvisioning() — transação única do Control Plane (Prompt 018):
    tenant_databases (READY) + tenant (READY) + provisioning_job (SUCCEEDED), atômicos
    ↓
falha na finalização → job permanece RUNNING, erro propaga sem tocar Control Plane
    (a infra externa já está pronta; um retry futuro só precisa refazer a finalização)
```

Idempotente diante de redelivery do BullMQ: job já `SUCCEEDED`/`FAILED` não é reprocessado;
job já `RUNNING` não é reexecutado concorrentemente pelo dispatcher/worker comum — mas, desde
o Prompt 019, deixar de ficar preso em `RUNNING` para sempre não depende mais de intervenção
manual: um mecanismo de recovery separado reclama jobs `RUNNING` cujo *execution lease*
expirou (worker morto/travado, incluindo o caso de crash durante a finalização) — ver bloco
"Execution lease, heartbeat e recovery" abaixo. `FAILED` é estado terminal nesta fase — sem
retry automático, nem do workflow nem do
BullMQ (`attempts: 1` explícito na publicação). **Distinção deliberada** (ADR-003): uma falha
do `DatabaseProvisioner` em si marca o job `FAILED` (não recuperável nesta fase); uma falha
*só* na finalização (infraestrutura externa já pronta, só a transação do Control Plane
falhou) nunca marca `FAILED` — marcar `FAILED` ali tornaria um database de tenant já
funcional inalcançável por qualquer retry futuro.

**IMPLEMENTED** (Prompt 019) — "Execution lease, heartbeat e recovery". Mecanismo
completamente independente do *dispatch lease* do dispatcher (ADR-002,
`dispatch_claimed_at`/`dispatch_lease_until`) — os dois nunca compartilham estado ou colunas:

```text
PENDING → RUNNING (markRunning, mesma escrita que a arbitragem PENDING→RUNNING):
    execution_token = gen_random_uuid(), execution_heartbeat_at = now(),
    execution_lease_until = now() + execution lease
    ↓
execução ativa: heartbeat renova execution_heartbeat_at/execution_lease_until em intervalo
    curto (PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS < lease em ms); uma falha transitória
    de renovação não aborta a execução (log e continua) — perder a posse (0 linhas afetadas)
    para o heartbeat
    ↓
loop de recovery (processo separado do worker BullMQ, mesmo runtime):
    claimExpiredRunningJobs — WHERE status='RUNNING' AND execution_lease_until <= now(),
    FOR UPDATE SKIP LOCKED, nunca toca dispatch_*, nunca rebaixa RUNNING→PENDING,
    concede novo execution_token + attempts += 1 (uma reclaim é uma nova tentativa real)
    ↓
job reclamado é executado diretamente pela camada de aplicação (executeRunningProvisioningJob)
    — nunca redespachado via BullMQ/fila
```

**Stale worker fencing**: toda escrita terminal (`finalizeProvisioning`, `markFailed`) exige
que o `execution_token` atual ainda corresponda ao token de quem está chamando; se um worker
antigo perdeu o lease para outra execução, sua escrita é recusada com
`ProvisioningExecutionOwnershipLostError` — o chamador para de forma controlada, sem
sobrescrever estado, sem marcar `FAILED`, sem finalizar. Exceção deliberada: o retry
idempotente de `finalizeProvisioning` quando o job já está `SUCCEEDED` **não** exige
correspondência de token, já que o token pode ter sido limpo pelo commit bem-sucedido
anterior. Em toda transição terminal (`SUCCEEDED`/`FAILED`), `execution_token` e
`execution_lease_until` são zerados, mas `execution_heartbeat_at` é preservado (última
atividade conhecida). `started_at` nunca é tocado por uma reclaim — só a claim original
PENDING→RUNNING o define; `finished_at` só em transição terminal.

Novas variáveis de ambiente (todas opcionais, com default):
`PROVISIONING_EXECUTION_LEASE_SECONDS`, `PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS`,
`PROVISIONING_RECOVERY_POLL_INTERVAL_MS`, `PROVISIONING_RECOVERY_BATCH_SIZE` — validação
cruzada garante que o intervalo de heartbeat é menor que a duração do lease. Migration
puramente aditiva no Control Plane: `execution_token`/`execution_heartbeat_at`/
`execution_lease_until` (nullable, sem backfill), constraint CHECK (lease exige token) e
índice parcial (`WHERE status = 'RUNNING'`) para a query de recovery — nenhuma migration no
Tenant Data Plane. Segurança da recovery apoia-se na mesma idempotência por descoberta do
`DatabaseProvisioner` (Prompt 017): reexecutar `provision()` para um job reclamado apenas
redescobre role/database/migrations/permissions já existentes.

**Runtime**: `src/workers/provisioning-worker.ts` agora compõe e inicia o pipeline real
completo (`DatabaseClusterSelector` → resolvedores de credencial → `TenantRoleProvisioner` →
`TenantDatabaseProvisioner` → migrations → permissions → `TenantDatabaseHealthChecker` →
`DatabaseProvisioner` → `finalizeProvisioning`) — a trava incondicional anterior ("nenhum
`DatabaseProvisioner` real existe") foi removida, já que um existe desde o Prompt 017. Uma
trava mais estreita e ainda real permanece: **recusa-se a iniciar especificamente sob
`NODE_ENV=production`**, porque não existe ainda um provider de `SecretStore` de produção
([ADR-004](adr/ADR-004-production-secret-store.md): AWS Secrets Manager é o provider alvo,
status PLANNED) — usar `createInMemorySecretStore` (que já se recusa a construir sob
produção, por conta própria) em um deploy real seria fingir prontidão que não existe. Fora de
produção (`development`/`test`), o worker inicia e processa jobs de verdade.

**IMPLEMENTED** — a arquitetura de provisionamento do database físico do tenant, decidida em
[ADR-003](adr/ADR-003-tenant-database-provisioning.md), agora está **totalmente
implementada e ligada ao worker** (Prompts 011–018):

```text
worker (application layer)
    ↓
DatabaseProvisioner.provision() — real, infraestrutura externa, nunca escreve no Control Plane
    ↓
DatabaseClusterSelector → cluster
    ↓
CREATE_ROLE → SAVE_CREDENTIALS → CREATE_DATABASE → RUN_MIGRATIONS → PERMISSIONS → HEALTH_CHECK
    ↓
retorna ProvisioningResult (clusterId, databaseName, secretReference, schemaVersion)
    ↓
worker persiste finalizeProvisioning() — transação única: tenant_databases + tenant READY + provisioning_job SUCCEEDED
```

Identidade técnica de database/role/secret derivada de `tenant.id` (nunca do `slug`);
cada etapa é idempotente por descoberta (reconhece recurso já criado em vez de recriar);
sem compensação destrutiva automática em falha parcial. `DatabaseProvisioner` executa e
descobre infraestrutura externa e retorna um resultado — quem persiste esse resultado no
Control Plane é a camada de aplicação (mesma dona da máquina de estado desde o Prompt 009),
nunca o provisionador. Database e objetos de migration pertencem à credencial
administrativa do cluster, não à role de aplicação do tenant (privilégio mínimo). Nenhuma
migration nova foi necessária — o schema atual já acomoda a decisão.

**IMPLEMENTED** — peças determinísticas e sem efeito externo da fundação de provisionamento
(`src/modules/provisioning/application/`, `src/modules/provisioning/infrastructure/`):

- `ProvisioningResult` (`provisioning-result.ts`) — tipo autônomo (`clusterId`,
  `databaseName`, `secretReference`, `schemaVersion`); ainda não usado por nenhum código,
  pois `DatabaseProvisioner.provision()` continua retornando `Promise<void>` (ver
  `process-provisioning-job.ts`) — mudar essa assinatura exige alterar a máquina de estado
  do worker, fora do escopo desta fundação.
- `buildProvisioningResourceNames(tenantId)` (`provisioning-resource-names.ts`) — função
  pura que deriva `databaseName` (`tenant_<uuid sem hífens>`), `roleName`
  (`tenant_<uuid sem hífens>_app`) e `secretReference` (`tenant-databases/<uuid canônico>`)
  exclusivamente de `tenant.id`; rejeita qualquer tenantId que não seja um UUID real
  (`InvalidTenantIdError`).
- `DatabaseClusterSelector` (`database-cluster-selector.ts`) — porta
  `selectClusterFor(tenantId)`; implementação real
  `createDrizzleDatabaseClusterSelector` (`infrastructure/drizzle-database-cluster-selector.ts`)
  busca por `database_clusters.name = TENANT_DATABASE_DEFAULT_CLUSTER AND status = 'ACTIVE'`
  — nunca seleciona automaticamente o primeiro cluster `ACTIVE` disponível. Ausência lança
  `DatabaseClusterNotAvailableError`, que nomeia o cluster procurado mas nunca expõe
  credenciais. Nova variável de ambiente obrigatória: `TENANT_DATABASE_DEFAULT_CLUSTER` (sem
  valor default).
- `SecretStore` (`secret-store.ts`) — porta `put`/`get`/`delete` sobre `unknown`: o boundary
  não afirma nenhuma tipagem que um provider externo real (AWS Secrets Manager, Vault, ...)
  não possa garantir. Validação do payload acontece no ponto de recuperação, não no
  armazenamento (ver `cluster-admin-credential-resolver.ts`). Sem implementação de produção
  ainda.

**IMPLEMENTED** — gestão de credenciais de database, distinta da fundação sem efeito externo
do Prompt 011 (`src/modules/provisioning/application/`, `src/modules/provisioning/test-support/`):

- `DatabaseCredential` (`database-credential.ts`) — shape estrutural comum (`{username,
  password}`), com `ClusterAdminCredential` e `TenantDatabaseCredential` como aliases
  semânticos (mesma forma hoje; não uma hierarquia artificial). Validados por schemas Zod
  **separados** (`clusterAdminCredentialSchema`/`tenantDatabaseCredentialSchema`, ambos
  `.strict()`) para poderem divergir de forma independente no futuro sem afetar o outro.
- `ClusterAdminCredentialResolver` (`cluster-admin-credential-resolver.ts`) —
  `resolve(secretReference)`: busca no `SecretStore`, valida com Zod, retorna
  `ClusterAdminCredential` tipado. Nunca faz cast não validado. Dois erros específicos:
  `ClusterAdminSecretNotFoundError` (nada no reference) e `InvalidClusterAdminSecretError`
  (payload existe mas falha a validação) — nenhum dos dois inclui o payload/senha, só a
  referência e, no segundo caso, os campos que falharam.
- `createTenantDatabaseCredential(roleName)` (`tenant-database-credential-generator.ts`) —
  função pura, sem I/O: `username` é sempre o `roleName` determinístico do Prompt 011 (nunca
  aleatório); `password` é gerado via `node:crypto` `randomBytes(32)` (256 bits) codificado
  em `base64url`. Chamada não persiste nada e não é acionada por nenhum fluxo ainda (não
  chamada por `POST /tenants`, dispatcher ou worker) — a geração pertence ao futuro
  `DatabaseProvisioner`.
- `createInMemorySecretStore` (`test-support/in-memory-secret-store.ts`) — fake de
  teste/desenvolvimento local; recusa-se a construir sob `NODE_ENV=production`, para que não
  possa ser conectado por acidente.

**IMPLEMENTED** — provisionamento idempotente da PostgreSQL application role do tenant
(`src/modules/provisioning/application/tenant-role-provisioner.ts`,
`src/modules/provisioning/infrastructure/postgres-tenant-role-provisioner.ts`), isolado e
testado, ainda **não** ligado ao `DatabaseProvisioner`/worker:

```text
tenantId + DatabaseCluster
    ↓
buildProvisioningResourceNames() — roleName, secretReference
    ↓
ClusterAdminCredentialResolver.resolve(cluster.secretReference)
    ↓
conexão administrativa (pg.Client, aberta e fechada por chamada — nunca um pool por tenant)
    ↓
reconcilia os 4 estados possíveis de (role, secret) — ver ADR-003, Prompt 013
    ↓
CREATE ROLE / ALTER ROLE (LOGIN, sem SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS)
    ↓
SecretStore.put() — só depois que a role já reflete a senha
```

`CREATE DATABASE`, `GRANT`, `ALTER DEFAULT PRIVILEGES`, migrations de tenant e health check
continuam fora do escopo deste componente. `database_clusters` ganhou `host`/`port` (única
migration desta tarefa) — sem eles não havia como abrir a conexão administrativa real.

**IMPLEMENTED** — provisionamento idempotente do database PostgreSQL do tenant e isolamento
inicial de CONNECT (`src/modules/provisioning/application/tenant-database-provisioner.ts`,
`src/modules/provisioning/infrastructure/postgres-tenant-database-provisioner.ts`), isolado e
testado, ainda **não** ligado ao `DatabaseProvisioner`/worker:

```text
tenantId + DatabaseCluster
    ↓
buildProvisioningResourceNames() — databaseName, roleName
    ↓
ClusterAdminCredentialResolver.resolve(cluster.secretReference)
    ↓
conexão administrativa (pg.Client, aberta e fechada por chamada — nunca um pool por tenant)
    ↓
pg_advisory_lock(hashtext(databaseName)) — serializa chamadas concorrentes para o mesmo tenant
    ↓
role de aplicação do tenant existe? não → TenantApplicationRoleNotFoundError, nada é criado
    ↓
database existe?
    ├── não → CREATE DATABASE (tolera duplicate_database/unique_violation real de uma corrida)
    └── sim → reutiliza
    ↓
REVOKE CONNECT ON DATABASE ... FROM PUBLIC
    ↓
GRANT CONNECT ON DATABASE ... TO <tenant_role>
    ↓
pg_advisory_unlock(hashtext(databaseName))
```

Precondição obrigatória: a application role do tenant (Prompt 013) precisa existir antes —
este componente nunca a cria por conta própria. Ownership do database permanece o padrão do
PostgreSQL (a credencial administrativa que executa o `CREATE DATABASE`), nunca a role do
tenant — nenhuma cláusula `OWNER` é adicionada. `REVOKE CONNECT FROM PUBLIC` seguido de
`GRANT CONNECT` para a role do tenant é reaplicado em toda chamada, mesmo com o database já
existente — reconcilia infraestrutura provisionada parcialmente ou por fora deste fluxo, sem
nunca reabrir `PUBLIC` como compensação (fail-closed). `GRANT USAGE`/DML em tabelas/schemas,
`ALTER DEFAULT PRIVILEGES`, migrations de tenant e health check continuam fora do escopo
deste componente.

**PLANNED** — `SecretStore` de produção ([ADR-004](adr/ADR-004-production-secret-store.md):
AWS Secrets Manager), política de retry para jobs `FAILED`.
`DatabaseProvisioner` real, criação de registros em `tenant_databases`, ativação do tenant
(`tenants.status = READY`) e recovery de jobs `RUNNING` abandonados (inclui crash durante a
finalização — Prompt 019) estão **IMPLEMENTED** — ver abaixo.

**PLANNED** — planos, assinaturas e billing ainda não possuem tabelas. `database_clusters`
e `provisioning_jobs` existem como schema, mas nenhum repository/service/endpoint próprio
lê ou escreve neles fora do fluxo de provisioning já implementado. `tenant_databases` já é
escrito pela finalização do provisioning (Prompt 018) — nenhuma leitura própria (Tenant
Registry) existe ainda.

**IMPLEMENTED** — schema inicial do Tenant Data Plane, migration runner e permissões da
application role (`src/infrastructure/database/tenant/schema.ts`,
`src/infrastructure/database/tenant/migrate.ts`,
`src/infrastructure/database/tenant/permissions.ts`, `drizzle/tenant/`), isolado e testado,
ainda **não** ligado ao `DatabaseProvisioner`/worker:

```text
tenant database existe (Prompt 014) + tenant application role existe (Prompt 013)
    ↓
runTenantMigrations(target) — pg_advisory_lock por database, aplica drizzle/tenant/*,
    devolve { schemaVersion } (contagem de linhas em drizzle.__drizzle_migrations)
    ↓
grantTenantApplicationPrivileges(target, roleName)
    REVOKE CREATE ON SCHEMA public FROM PUBLIC (fail-closed, não confia só no default do PG15+)
    GRANT USAGE ON SCHEMA public
    GRANT SELECT/INSERT/UPDATE/DELETE ON ALL TABLES IN SCHEMA public
    GRANT USAGE/SELECT ON ALL SEQUENCES IN SCHEMA public
    ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES/SEQUENCES (objetos de migrations futuras)
```

`target` é sempre a credencial administrativa/de migration do cluster (nunca a tenant
application role — DDL nunca é privilégio da role do tenant). Schema inicial:
`users`/`audit_logs`/`outbox_events`, nenhuma com coluna `tenant_id` — o database físico já é
o boundary de isolamento (ADR-001). Diretório de migrations (`drizzle/tenant/`) e config
Drizzle Kit (`drizzle.tenant.config.ts`, script `pnpm tenant-db:generate`) completamente
separados do Control Plane. Não existe script `tenant-db:migrate` — só o runner programático,
já que não há "o" database de tenant único para um script aplicar migrations contra;
aplicar em todos os tenants (rollout/batch/canário) é decisão futura.

**IMPLEMENTED** — `DatabaseProvisioner` real, compondo todas as peças acima, mais o health
check do Tenant Data Plane
(`src/modules/provisioning/infrastructure/postgres-database-provisioner.ts`,
`src/modules/provisioning/application/tenant-database-health-checker.ts`,
`src/modules/provisioning/infrastructure/postgres-tenant-database-health-checker.ts`,
`src/modules/provisioning/application/tenant-database-credential-resolver.ts`), isolado e
testado, ainda **não** ligado ao worker:

```text
tenantId
    ↓
DatabaseClusterSelector.selectClusterFor(tenantId) → cluster
    ↓
TenantRoleProvisioner.ensureRole({tenantId, cluster})       — Prompt 013
    ↓
TenantDatabaseProvisioner.ensureDatabase({tenantId, cluster}) — Prompt 014
    ↓
ClusterAdminCredentialResolver.resolve(cluster.secretReference) — uma vez, reaplicado nos dois passos abaixo
    ↓
runTenantMigrations(target) → { schemaVersion }              — Prompt 015
    ↓
grantTenantApplicationPrivileges(target, roleName)            — Prompt 015
    ↓
TenantDatabaseCredentialResolver.resolve(secretReference) → credencial do tenant
    ↓
TenantDatabaseHealthChecker.check({cluster, databaseName, credential, expectedSchemaVersion})
    ↓
ProvisioningResult { clusterId, databaseName, secretReference, schemaVersion }
```

`DatabaseProvisioner.provision()` (`process-provisioning-job.ts`) retorna
`Promise<ProvisioningResult>`. Desde o Prompt 018, `processProvisioningJob` usa esse
resultado (deixou de descartá-lo): chama `repository.finalizeProvisioning()` em vez do
antigo `markSucceeded()` isolado — ver bloco de finalização acima e o Prompt 018 na ADR-003.
Erros de cada etapa são encapsulados em `DatabaseProvisioningError` com mensagem controlada
por passo (ADR-003 "Security"), preservando a causa original só em `.cause`.

Health check: autentica com a **credencial de aplicação do tenant** (nunca a administrativa)
contra o database do tenant, confirma `current_database()`, executa `SELECT 1`, e compara o
número de migrations aplicadas (`drizzle.__drizzle_migrations`, consultado com a própria
credencial do tenant) contra o `schemaVersion` real devolvido por `runTenantMigrations`.
`grantTenantApplicationPrivileges` (Prompt 015) ganhou um `GRANT` adicional, mínimo e
somente leitura (`USAGE` no schema `drizzle` + `SELECT` em
`drizzle.__drizzle_migrations`), exigido para essa comparação funcionar com a credencial do
tenant em vez de uma segunda conexão administrativa.

Fronteira obrigatória (ADR-003, CLAUDE.md): `DatabaseProvisioner` só executa/descobre
infraestrutura externa e retorna um resultado — nunca escreve em
`tenants`/`provisioning_jobs`/`tenant_databases`. Idempotente ponta a ponta: uma segunda
chamada para o mesmo tenant reconhece role/database/migrations/permissions já existentes,
não rotaciona a senha, e converge para o mesmo `ProvisioningResult`.

**IMPLEMENTED** (Prompt 018) — este `DatabaseProvisioner` está ligado ao worker, e a
finalização transacional do Control Plane (`tenant_databases` + tenant `READY` +
`provisioning_job SUCCEEDED`, atômicos) está implementada — ver o bloco do worker acima e
ADR-003 "Finalization". **IMPLEMENTED** (Prompt 019): recovery de jobs `RUNNING` abandonados
(inclui o caso de crash durante a finalização) — ver "Execution lease, heartbeat e recovery"
acima. **PLANNED**: política de retry para jobs `FAILED`.

### Tenant administrative listing — IMPLEMENTED (Prompt 033)

```http
GET /api/v1/tenants
```

Listagem administrativa de tenants, lida **exclusivamente do Control Plane**
(`src/modules/tenants/`) — nunca abre conexão com o database de nenhum tenant individual
(seção 31/32 do Prompt 033: uma única consulta estruturada, sem N+1).

```text
tenants
    LEFT JOIN tenant_databases ON tenant_databases.tenant_id = tenants.id
    LEFT JOIN database_clusters ON database_clusters.id = tenant_databases.cluster_id
```

Os dois `LEFT JOIN` nunca duplicam um tenant na listagem: `tenant_databases.tenant_id` tem
constraint `UNIQUE` (no máximo um database por tenant) e `tenant_databases.cluster_id` é uma FK
`NOT NULL` para `database_clusters` — então, no máximo, um tenant casa com uma linha de cada
tabela. `database` no item de resposta é `null` exatamente quando não existe
`tenant_databases` ainda (tenant em `PROVISIONING`, por exemplo) — nunca um objeto artificial;
`cluster` seria `null` apenas no caso defensivo de um `tenant_databases` apontar para um
cluster não resolvido pelo JOIN, o que a FK `NOT NULL` já torna inalcançável hoje.

Filtros (opcionais, combinados com AND): `status` (exato, um dos 4 valores do enum
`tenant_status`) e `q` (substring case-insensitive via `ILIKE '%...%'` sobre `name`/`slug` —
nunca full-text search, section 7 do prompt). Paginação: `page`/`limit` (mesma convenção já
usada por `GET /api/v1/properties` — não `page_size`, para não introduzir um segundo padrão de
paginação no projeto). Ordenação fixa e determinística: `created_at DESC, id DESC` — sem
`sort` exposto nesta primeira versão.

**Nunca retorna secret/credencial**: `secret_reference` (de `database_clusters` e de
`tenant_databases`), senha, connection string — nenhum desses campos chega à porta
`TenantRepository.list()` nem à resposta HTTP. `database_name` é devolvido (identificador
técnico, não segredo).

**Desvio do rascunho original do prompt**: o schema `tenants` não tem colunas `email`/`plan_id`
(nunca existiram, nem no `POST /api/v1/tenants` atual). Adicioná-las exigiria uma migration —
decisão explicitamente interrompida e confirmada com o usuário antes de prosseguir (nenhuma
migration foi criada nesta tarefa). A busca `q` e a resposta cobrem apenas `name`/`slug`.

**Autorização administrativa: PLANNED.** Esta rota pertence conceitualmente ao Control Plane/
API administrativa, não à API pública por tenant (`X-Tenant-Id`) — mas nenhuma autenticação é
aplicada a ela ainda, e nenhum mecanismo temporário (`X-Admin-Id` ou similar) foi inventado
para simular uma. A ausência é uma lacuna conhecida e documentada, não mascarada.

## Tenant Data Plane

Cada tenant possui seu **próprio database PostgreSQL exclusivo**. Ver
[ADR-001](adr/ADR-001-database-per-tenant.md) para a decisão completa e as alternativas
consideradas.

```text
PostgreSQL Cluster
│
├── tenant_a
├── tenant_b
├── tenant_c
└── tenant_d
```

Tenants podem, no futuro, estar distribuídos entre múltiplos clusters PostgreSQL, e
determinados clientes podem ter infraestrutura PostgreSQL dedicada. **O código de domínio
nunca deve assumir que todos os tenants estão no mesmo database ou cluster.**

Estado atual: a infraestrutura local (`postgres-tenants` no Docker Compose) está disponível,
e o provisioning dinâmico de databases de tenant está implementado desde os Prompts 011–018
(ver seção Control Plane acima) — cada tenant `READY` já possui um database físico real,
provisionado sob demanda.

## Runtime tenant database (resolver + connection manager)

Fluxo completo, do request até o database físico do tenant:

```text
Request
   ↓
Authentication           (PLANNED — ver "Tenant context HTTP" abaixo)
   ↓
Tenant Context            ← IMPLEMENTED, temporário (Prompt 021 — X-Tenant-Id)
   ↓
TenantDatabaseResolver   ← IMPLEMENTED (Prompt 020)
   ↓
TenantDatabaseConnectionManager ← IMPLEMENTED (Prompt 020)
   ↓
Tenant Database (Tenant Data Plane, real PostgreSQL)
```

**IMPLEMENTED** (Prompt 020) — `TenantDatabaseResolver`
(`src/modules/tenant-runtime/application/tenant-database-resolver.ts`,
`.../infrastructure/drizzle-tenant-database-resolver.ts`): dado um `tenantId`, resolve um
`TenantDatabaseTarget` (`tenantId`, `clusterId`, `host`, `port`, `databaseName`,
`secretReference`, `schemaVersion` — nunca uma senha) consultando sempre o Control Plane, na
ordem `tenants → tenant_databases → database_clusters`, e nunca derivando o database
diretamente de `tenantId`/`slug` (ADR-001/CLAUDE.md) mesmo sendo o naming determinístico.
Cada chamada é revalidada do zero — nunca cacheada entre chamadas — para que um tenant
suspenso após uma resolução anterior bem-sucedida seja recusado na próxima:

```text
tenants.status != READY               → TenantNotReadyError
tenant_databases ausente/status != READY → TenantDatabaseNotAvailableError
database_clusters ausente/status != ACTIVE → TenantDatabaseRuntimeConfigurationError
```

**IMPLEMENTED** (Prompt 020) — `TenantDatabaseConnectionManager`
(`src/modules/tenant-runtime/application/tenant-database-connection-manager.ts`,
`.../infrastructure/pg-tenant-database-connection-manager.ts`): dado um `TenantDatabaseTarget`
já resolvido, abre (e reutiliza) uma conexão real, sempre autenticada com a **credencial de
aplicação do tenant** resolvida de `target.secretReference` via `TenantDatabaseCredentialResolver`
— nunca a credencial administrativa do cluster (`database_clusters.secret_reference`), que
permanece de uso exclusivo de provisioning/migrations/manutenção. Um `pg.Pool` (com
`drizzle-orm/node-postgres`, tipado exclusivamente com o schema do Tenant Data Plane — tabelas
do Control Plane não aparecem nesse tipo) por tenant, cacheado por `tenantId` em um `Map`
limitado (`maxPools`, default 50) com eviction least-recently-used — nunca um único `Pool`
compartilhado alternando database/credential por chamada, e nunca pools ilimitados para
tenants ilimitados. A resolução da credencial acontece (e pode falhar) antes de qualquer
`pg.Pool` ser criado — um secret ausente ou inválido nunca resulta em tentativa de conexão.
`invalidate(tenantId)` fecha e descarta o pool cacheado de um tenant (preparado para uma
futura rotação de credencial, ainda não implementada); `close()` encerra todos os pools
cacheados, para uso em shutdown gracioso.

Estratégia de pooling desta fase (avaliada e documentada, seção 13 do Prompt 020): *lazy pool
per tenant* + *cache limitado por capacidade* (eviction least-recently-used quando `maxPools`
é atingido). Deliberadamente **não** implementado nesta tarefa: eviction proativa por
ociosidade (remover do cache o pool de um tenant sem uso há N minutos) — cada `pg.Pool`
individual já usa `idleTimeoutMillis` para encerrar conexões físicas ociosas *dentro* do seu
próprio pool, mas isso não remove a entrada do tenant do cache do connection manager. Uma
eviction por tempo ocioso é um refinamento futuro razoável, não implementado por ser
prematuro sem um padrão real de tráfego observado ainda.

Isolamento físico A/B (confirmado com dois tenants reais, provisionados ponta a ponta, e
revalidado no mesmo teste com o mesmo tipo de prova já usada no nível do provisionador —
`postgres-tenant-database-provisioner.test.ts` — de que a credencial de um tenant nunca
consegue conectar ao database de outro): **IMPLEMENTED**
(`src/modules/tenant-runtime/e2e-tenant-database-runtime.test.ts`).

**IMPLEMENTED** (Prompt 021) — `src/app/build-app.ts` agora recebe um
`TenantDatabaseConnectionManager` já construído (`BuildAppDependencies`), nunca o constrói
internamente — qual `SecretStore` o alimenta (e, em particular, se ele é compartilhado com um
processo de worker separado) é uma decisão de composição do entrypoint chamador
(`server.ts`/`dev-full.ts`/testes), não algo que `buildApp()` decide sozinho. Um hook
`onClose` do Fastify fecha esse connection manager automaticamente quando a app é fechada —
nunca um singleton impossível de fechar.

### Tenant context HTTP — mecanismo temporário

**IMPLEMENTED** (Prompt 021), deliberadamente provisório: `src/app/tenant-context.ts`
resolve um `TenantContext { tenantId }` a partir do header `X-Tenant-Id` obrigatório em toda
rota de domínio, validado (presente + UUID válido) *antes* de qualquer consulta ao Control
Plane/Tenant Data Plane. Encapsulado em `resolveTenantContext(request)` — nenhum handler lê
`request.headers["x-tenant-id"]` diretamente — para que, quando autenticação real existir,
apenas essa função precise mudar.

**`X-Tenant-Id` não é autenticação.** Qualquer cliente que conheça um `tenantId` pode informar
esse header — nada aqui prova que o chamador tem autorização para agir como aquele tenant.
Por isso: nenhum termo como "authenticated tenant"/"authorized user" é usado em código ou
documentação para esse mecanismo; a API de Properties não deve ser considerada pronta para
exposição pública enquanto autenticação real não existir; e o fail-fast de produção existente
(nenhum `SecretStore` de produção — ADR-004) permanece intacto e não foi enfraquecido.

- **Tenant Registry**: hoje é diretamente `tenant_databases`/`database_clusters`, consultados
  pelo `TenantDatabaseResolver` — não existe (nem é necessária ainda) uma camada de cache
  separada.
- **Tenant Resolver HTTP/autenticação — PLANNED**: identificar qual `tenantId` uma requisição
  *autenticada* representa. Não decidido nesta tarefa — a futura identificação pode vir do
  contexto autenticado e/ou de domínio/slug, dependendo da rota; `X-Tenant-Id` não é assumido
  como mecanismo definitivo de produto. Nunca a partir de parâmetros informados livremente
  pelo cliente (`databaseName`, `databaseUrl`, etc.).

## Properties (primeiro módulo de domínio)

**IMPLEMENTED** (Prompts 021-022) — primeiro módulo funcional do domínio imobiliário
(`src/modules/properties/`), provando de ponta a ponta a regra final desta fase: uma rota
HTTP de domínio opera exclusivamente no Tenant Data Plane correto, sem `tenant_id` nas
tabelas e sem credencial administrativa. Ciclo completo create/read/list/update/archive —
**sem exclusão física**.

```text
POST   /api/v1/properties
GET    /api/v1/properties
GET    /api/v1/properties/:id
PATCH  /api/v1/properties/:id   (Prompt 022 — atualização parcial)
DELETE /api/v1/properties/:id   (Prompt 022 — arquivamento, nunca DELETE físico)
```

```text
request
    ↓
resolveTenantContext(request)                 — X-Tenant-Id, seção acima
    ↓
TenantDatabaseResolver.resolve(tenantId)      — Prompt 020
    ↓
TenantDatabaseConnectionManager.withTenantDatabase(target, ...)  — Prompt 020
    ↓
PropertyRepository (Drizzle, tipado só com o schema do Tenant Data Plane)
    ↓
CreateProperty / ListProperties / GetProperty (application layer, sem SQL)
```

Nenhum handler conhece `host`/`port`/`databaseName`/`secretReference` — esses detalhes vivem
inteiramente dentro de `TenantDatabaseTarget`, resolvidos e consumidos sem sair da função de
registro das rotas.

**Schema** (`src/infrastructure/database/tenant/schema.ts`, Tenant Data Plane) — tabela
`properties`, **sem coluna `tenant_id`** (o database físico já é o boundary de isolamento,
ADR-001; nenhuma outra tabela deste schema tem essa coluna e esta não é exceção). Campos:
`title` (obrigatório), `description`, `property_type`
(`HOUSE`/`APARTMENT`/`LAND`/`COMMERCIAL`/`OTHER`), `transaction_type` (`SALE`/`RENT`),
`status` (`DRAFT`/`ACTIVE`/`INACTIVE` — deliberadamente sem `SOLD`/`RENTED`, que exigiriam uma
máquina de estado própria fora do escopo desta tarefa), `price` `numeric(15,2)` (nunca float),
`bedrooms`/`bathrooms`/`parking_spaces` (inteiros, nullable), `area_m2` `numeric(10,2)`
(nullable), campos de endereço (`street`/`number`/`complement`/`neighborhood`/`city`/`state`/
`postal_code`, todos nullable — `state` é `varchar(2)`, nunca uma tabela de UFs), timestamps
`TIMESTAMPTZ`. Checks: `price > 0`,
`bedrooms`/`bathrooms`/`parking_spaces >= 0` (quando presentes), `area_m2 > 0` (quando
presente). Índice único: `(created_at DESC, id DESC)`. `GET /api/v1/properties` ganhou filtros
estruturados e ordenação no Prompt 023 (ver seção "Properties" abaixo), mas nenhum índice novo
foi adicionado por conta disso — sem dados/`EXPLAIN` reais de uso, adicionar índices por filtro
seria otimização prematura; permanece uma avaliação futura, não implementada nesta tarefa.
`search_vector` `tsvector` (Prompt 025 — ver seção "Properties full-text search" abaixo),
`GENERATED ALWAYS AS (...) STORED`, com índice `GIN` dedicado — esse índice, ao contrário dos
demais, foi adicionado propositalmente sem dados de uso reais, porque a coluna que ele cobre
não serve a nenhum outro propósito.

**Migration**: `drizzle/tenant/0001_fancy_blackheart.sql` (tabela `properties`),
`drizzle/tenant/0002_add_property_search_vector.sql` (Prompt 025 — coluna `search_vector` +
índice GIN) e `drizzle/tenant/0003_add_property_media.sql` (Prompt 027 — tabela
`property_media`), todas puramente aditivas (nenhuma migration no Control Plane).
`schemaVersion` (contagem de `drizzle.__drizzle_migrations`) passa de 1 para 4 em qualquer
tenant database migrado a partir desta tarefa (2 após o Prompt 023, 3 após o Prompt 025, 4 após
o Prompt 027) — `runTenantMigrations()`/o provisioner aplicam-nas automaticamente para tenants
novos, sem nenhuma mudança de lógica.

**PLANNED** — rollout de migration para tenant databases já existentes antes destas tarefas
(ficam parados em `schemaVersion` antigo, sem `properties`/`search_vector`/`property_media`
conforme o caso, até serem migrados manualmente) — pendência que cresceu de novo com o Prompt
027: um tenant sem `0003` não tem `property_media`, então
`POST/GET /api/v1/properties/:id/media` falha com um erro de infraestrutura controlado (nunca
um fallback silencioso) até essa migration ser aplicada a ele. Rodar migrations dentro de uma
requisição HTTP normal é expressamente proibido (nunca implementado, nem será) — ver
`TenantDatabaseConnectionManager`, que só abre conexões, nunca aplica DDL. Um mecanismo de
rollout em lote/canário para tenants existentes é trabalho de infraestrutura futuro, fora do
escopo desta tarefa.

**Money contract HTTP**: `price`/`area_m2` trafegam como **string decimal** (ex.: `"450000.00"`),
nunca `number` — evita perda de precisão do JavaScript sobre valores arbitrariamente grandes.
Documentado no Swagger (`property-openapi.schema.ts`).

**Validação** (`property-request.schema.ts`, Zod): `title` trimmed/obrigatório;
`property_type`/`transaction_type`/`status` são enums fechados; `price`/`area_m2` exigem um
formato de string decimal (até 2 casas) e valor `> 0`; `bedrooms`/`bathrooms`/
`parking_spaces` são inteiros `>= 0` quando presentes; `state` normaliza para 2 letras
maiúsculas. O JSON Schema do corpo da requisição (usado só para o Swagger) é deliberadamente
solto — sem `enum`/`minimum`/`required` reais — pelo mesmo motivo já registrado em
`tenant-openapi.schema.ts`: a validação AJV do Fastify roda *antes* do handler, e encoder
essas regras ali faria a API responder com o formato de erro genérico do AJV em vez do
envelope `{statusCode, error, message, details}` desta API.

**IMPLEMENTED** (Prompt 022) — `PATCH /api/v1/properties/:id`, atualização parcial:

- **Semântica PATCH**: campo ausente do body = preservar; campo presente = alterar; para os
  campos nullable do domínio, campo presente com `null` explícito = limpar. `Zod` nunca
  preenche uma chave ausente de um campo `.optional()` — é exatamente essa propriedade que
  permite ao handler distinguir "ausente" de "`null` explícito" via `"campo" in body`, sem
  jamais confundir os dois (Prompt 022, seções 43/44).
- **`updatePropertyBodySchema` é um schema Zod próprio, não `createPropertyBodySchema
  .partial()`** — reaproveitar cegamente o create colapsaria "ausente" e "`null`" no mesmo
  `null` (os helpers do create já fazem esse `.nullish().transform(() => null)` de propósito
  para a criação). `.strict()` rejeita qualquer chave fora do schema — incluindo
  `id`/`created_at`/`updated_at`/`tenant_id`, que simplesmente nunca fazem parte dele —, e um
  `.refine()` rejeita um body vazio (`{}` → 400, nunca um update sem efeito).
- **Campos obrigatórios no create** (`title`, `property_type`, `transaction_type`, `price`)
  continuam não-nulos no update: podem ser omitidos (mantém o valor atual) mas nunca limpos
  com `null`.
- `repository.update(id, input)` roda um único `UPDATE ... SET ...spread(input),
  updated_at = now() WHERE id = $1 RETURNING *` — `updated_at` sempre via `now()` do
  PostgreSQL (mesmo padrão já usado em `drizzle-process-provisioning-job-repository.ts`),
  nunca `new Date()` da aplicação; `created_at` nunca é tocado. Retorna `undefined` quando o
  id não existe — a camada de aplicação (`updateProperty()`) traduz isso em
  `PropertyNotFoundError` → `404`.

**IMPLEMENTED** (Prompt 022) — `DELETE /api/v1/properties/:id`, arquivamento:

```text
DELETE HTTP  ≠  DELETE SQL
DELETE HTTP  →  UPDATE properties SET status = 'INACTIVE', updated_at = now() WHERE id = $1
```

Nenhum `DELETE FROM properties` existe em código de produção — `archive()`
(`drizzle-property-repository.ts`) sempre executa o mesmo `UPDATE`, nunca um `DELETE`
físico, preservando o registro e seu histórico (CLAUDE.md). **Idempotente por convergência**
(mesmo princípio já usado para idempotência de provisioning nesta base de código): arquivar
um imóvel já `INACTIVE` roda o mesmo `UPDATE` de novo e retorna `204` de novo — nunca um erro
só porque já estava arquivado. `GET`/listagem continuam retornando imóveis `INACTIVE`
normalmente (arquivamento não é exclusão lógica invisível nesta fase — filtro por status é
prompt futuro). Sem `deleted_at`: os três estados existentes (`DRAFT`/`ACTIVE`/`INACTIVE`) já
bastam para representar "arquivado" sem introduzir uma segunda dimensão de estado.

**Error mapping** (`property-error-mapper.ts`) — central, nenhum handler tem seu próprio
`if (error instanceof ...)`:

```text
X-Tenant-Id ausente/inválido                              → 400
PropertyNotFoundError                                      → 404
TenantNotReadyError (qualquer status != READY, inclusive
    tenant inexistente)                                    → 409
TenantDatabaseNotAvailableError /
TenantDatabaseRuntimeConfigurationError (cluster INACTIVE) /
TenantSecretNotFoundError / InvalidTenantSecretError        → 503
```

**Decisão deliberada, ver seções 49-51 do Prompt 021**: todo motivo de "tenant não utilizável
agora" (`PROVISIONING`, `FAILED`, `SUSPENDED`, e também um `tenantId` que simplesmente não
existe) mapeia para o **mesmo** `409 Conflict` — nunca `404` para "tenant inexistente" nem
`403` para `SUSPENDED`. Como `X-Tenant-Id` não é autenticação, diferenciar esses casos pelo
código HTTP permitiria a um chamador não autenticado enumerar `tenantId`s válidos só
observando a resposta. `TenantDatabaseNotAvailableError`/cluster `INACTIVE`/secret ausente ou
inválido mapeiam para `503` — são problemas de infraestrutura/operação, nunca algo que o
chamador corrija mudando a requisição; nenhuma mensagem inclui detalhe interno (qual check
falhou, nome do cluster, secret reference).

**IMPLEMENTED** (Prompt 023) — `GET /api/v1/properties` ganhou filtros estruturados
(`status`/`property_type`/`transaction_type`/`city`/`state`/`price_min`/`price_max`/
`bedrooms_min`/`bathrooms_min`/`parking_spaces_min`/`area_min`/`area_max`, todos opcionais,
combinados com AND) e ordenação (`sort`/`order`) — validados e normalizados por Zod na fronteira
HTTP (`property-request.schema.ts`), nunca interpretados pelo repository, que só recebe um
`PropertyListFilters`/`PropertySort`/`SortOrder` já prontos (`property-repository.ts`). Parâmetro
de query desconhecido é rejeitado com `400` (nunca ignorado silenciosamente). `city` é
case-insensitive exato após trim (`ilike` sem wildcards), nunca substring/full-text; `sort` é uma
allowlist fechada (`created_at`/`updated_at`/`price`/`area_m2`/`bedrooms`) sempre mapeada para
uma coluna Drizzle conhecida — a string bruta de `sort`/`order` nunca é interpolada em SQL.
Colunas nullable (`area_m2`/`bedrooms`) ordenam com `NULLS LAST` explícito em ambas as direções;
toda ordenação é desempatada por `id` na mesma direção do sort principal, para paginação sempre
estável. `pagination.total`/`total_pages` refletem o total **filtrado**, nunca o total geral do
tenant — a mesma função que constrói os predicados WHERE alimenta a query de dados e a de
`count(*)`, para as duas nunca divergirem (`drizzle-property-repository.ts`). Sem migration nesta
tarefa: o índice existente (`created_at DESC, id DESC`) já bastava para a fase atual; índices
adicionais por filtro ficam como avaliação futura, sem dados reais de uso para justificá-los
agora. Busca full-text (`q`) foi **IMPLEMENTED** no Prompt 025, logo abaixo; busca por
proximidade/geolocalização continua **PLANNED**.

**IMPLEMENTED** (Prompt 025) — `GET /api/v1/properties?q=` — busca textual via PostgreSQL Full
Text Search, nunca um serviço de busca externo (Elasticsearch/OpenSearch — ver
[ADR-005](adr/ADR-005-postgresql-full-text-search.md)).

```text
q (query string, trimmed, 2-120 caracteres — vazio/curto/longo demais → 400)
    ↓
property-request.schema.ts (Zod) — validação/normalização, nunca no repository
    ↓
PropertyListFilters.query (property-repository.ts)
    ↓
drizzle-property-repository.ts:
    WHERE search_vector @@ websearch_to_tsquery('portuguese', $1)   — AND com os demais filtros
    ORDER BY ts_rank(search_vector, websearch_to_tsquery('portuguese', $1)) DESC, id DESC
        (somente quando `sort` não foi enviado explicitamente — ver "Ranking" abaixo)
```

**Search vector**: `properties.search_vector tsvector`, `GENERATED ALWAYS AS (...) STORED`
(`infrastructure/database/tenant/schema.ts`) — PostgreSQL recalcula automaticamente em todo
`INSERT`/`UPDATE`, nunca escrito por código de aplicação (`CreatePropertyInput`/
`UpdatePropertyInput` não têm nem podem ter esse campo). Modelado via `customType` do Drizzle
(`tsvector` não tem tipo de coluna nativo) — a expressão geradora referencia as próprias
colunas da tabela através de um callback (`(): SQL => sql\`...${properties.title}...\``), o
padrão documentado do Drizzle para colunas geradas que dependem de colunas irmãs. Construído a
partir de `title`/`neighborhood`/`city`/`street`/`description` (`coalesce(..., '')` para
colunas nullable) — nunca `price`/`postal_code`/`state`/`property_type`/`transaction_type`/
`status`, que já têm filtro estruturado ou não são bons candidatos a FTS. Pesos via
`setweight()`: `title` (A) > `neighborhood`/`city` (B) > `street` (C) > `description` (D) — uma
ocorrência no título ranqueia acima da mesma palavra só na descrição. Índice `GIN` dedicado
sobre `search_vector` (seção "Schema" acima). Config `'portuguese'` confirmada disponível na
imagem `postgres:17-alpine` usada por este projeto (`SELECT cfgname FROM pg_ts_config WHERE
cfgname = 'portuguese'`) antes de escrever qualquer código.

**Query parsing**: sempre `websearch_to_tsquery('portuguese', $1)`, nunca `to_tsquery` bruto —
aceita input natural (`apartamento centro`, `"vista mar"`, `apartamento -reforma`) sem exigir
sintaxe de tsquery do usuário, e nunca lança erro de sintaxe para input arbitrário (ao contrário
de `to_tsquery`). O texto de `q` é sempre um parâmetro Drizzle (`sql\`...${query}...\``), nunca
concatenado na string SQL — nenhuma superfície de SQL injection nova.

**Ranking**: sem `sort` explícito, `q` presente → `PropertySort` interno resolve para
`"relevance"` (`query.sort ?? (query.q !== undefined ? "relevance" : "created_at")` em
`property-routes.ts`) — `"relevance"` nunca é um valor que o cliente pode enviar em `?sort=`
(fora de `PROPERTY_SORT_FIELDS`/o enum Zod), só um resultado interno dessa resolução. Ordena por
`ts_rank(...) DESC, id DESC` — `order` não tem efeito nesse modo (uma única ordenação
determinística, não uma direção configurável sobre relevância). Um `sort` explícito
(`sort=price`, por exemplo) sempre vence sobre relevância, mesmo com `q` presente — `q` continua
filtrando via `WHERE`, só deixa de controlar a ordenação. O valor numérico do rank nunca é
exposto na resposta HTTP — detalhe interno de ordenação.

**Limitações conhecidas, verificadas empiricamente** (nunca resolvidas silenciosamente nesta
tarefa — CLAUDE.md/seção 64 do Prompt 025):
- **Acentuação**: o dicionário `portuguese` do PostgreSQL não normaliza acentos por padrão —
  `q=panoramica` (sem acento) **não** encontra um texto com "panorâmica" (testado manualmente
  contra um tenant real). A extensão `unaccent` resolveria isso, mas não foi adicionada nesta
  tarefa (decisão explícita, não uma omissão).
- **Stemming**: funciona para variações morfológicas reais do português — `q=reforma` encontra
  um texto contendo "Reformado" (testado manualmente).

**Permissions**: nenhuma alteração em `grantTenantApplicationPrivileges`
(`infrastructure/database/tenant/permissions.ts`) — `GRANT SELECT/INSERT/UPDATE/DELETE ON ALL
TABLES` já cobre a tabela inteira, incluindo a coluna gerada; nem a coluna `tsvector` nem o
índice `GIN` são objetos com ACL própria além do nível de tabela.

**IMPLEMENTED** — isolamento A/B provado em nível HTTP
(`src/modules/properties/http/property-routes.test.ts`): tenant A cria, tenant A vê na
listagem/`GET :id`, tenant B nunca vê na listagem, `GET :id` do recurso de A usando o header
de B retorna `404` (a query sequer roda no database de B — nunca uma consulta cruzada que
"acerta por acidente" e é bloqueada depois). Estendido no Prompt 022:
`PATCH`/`DELETE` do recurso de A usando o header de B também retornam `404` (nunca revelando
que o recurso existe em outro database) e o registro em A permanece intacto — confirmado
lendo o estado real de A após a tentativa de B, e confirmando que A ainda consegue
atualizar/arquivar seu próprio recurso normalmente em seguida.

## Redis / BullMQ

Redis está disponível localmente (Docker Compose) e no CI. **IMPLEMENTED**: a fila
`tenant-provisioning` (`src/infrastructure/queue/`), alimentada pelo dispatcher de
provisionamento e consumida por um `Worker` BullMQ real
(`src/modules/provisioning/infrastructure/bullmq-provisioning-worker.ts`), com o
`DatabaseProvisioner` real e a finalização transacional já ligados (Prompt 018). Publicação
sem retry automático (`attempts: 1` explícito) — o workflow de provisionamento não reinventa
sua política de retry no BullMQ; o mecanismo que evita um job preso para sempre em `RUNNING`
é o recovery baseado em execution lease (Prompt 019), não o BullMQ. O loop de recovery roda no
mesmo processo do entrypoint do worker (`src/workers/provisioning-worker.ts`), mas como um
componente independente do `Worker` BullMQ — nunca redespacha um job reclamado de volta para a
fila, chama a camada de aplicação diretamente. `entrypoint` do worker ainda se recusa a
iniciar especificamente sob `NODE_ENV=production`, por não existir ainda um provider de
`SecretStore` de produção (ver seção Control Plane) — essa trava não mudou com o Prompt 019.
**PLANNED**: `SecretStore` de produção em si ([ADR-004](adr/ADR-004-production-secret-store.md)).

### Local development runtime — o gap de SecretStore entre processos

A API HTTP (`src/main/server.ts`), o worker de provisionamento
(`src/workers/provisioning-worker.ts`) e o dispatcher
(`src/workers/provisioning-dispatcher.ts`) são **processos separados de verdade** — essa é a
topologia real, inclusive em produção. Cada um constrói sua própria instância de
`createInMemorySecretStore()` (o único `SecretStore` que existe hoje — ADR-004). Como essa
implementação é apenas um `Map` em memória de processo, **um secret de tenant escrito pelo
worker durante o provisioning não é visível para a API rodando como outro processo** — e
vice-versa. Isso não é um bug: é a consequência honesta e esperada de não existir ainda um
`SecretStore` de produção real compartilhado (AWS Secrets Manager, ADR-004) nem qualquer
outro mecanismo de compartilhamento local seguro. Nenhum fallback para a credencial
administrativa do cluster existe ou é permitido para contornar isso.

**IMPLEMENTED** (Prompt 021; Prompt 031 acrescentou o dispatcher de outbox de mídia; Prompt 032
acrescentou o worker de processamento de imagens) — `src/main/dev-full.ts` (`pnpm dev:full`), um
runtime **somente de desenvolvimento** que sobe a API HTTP, o worker de provisionamento, o
dispatcher de outbox de mídia, e o worker de processamento de imagens no mesmo processo,
compartilhando a mesma instância de `SecretStore`:

```text
pnpm dev:full
    ↓
uma única composição de dependências
    ↓
InMemorySecretStore compartilhado
    ├── HTTP API (build-app.ts → TenantDatabaseConnectionManager)
    ├── provisioning worker (createProvisioningWorkerRuntime)
    ├── media outbox dispatcher (createMediaOutboxDispatcherRuntime — Prompt 031)
    └── media processing worker (createMediaProcessingWorkerRuntime — Prompt 032)
```

`createProvisioningWorkerRuntime()` (`src/workers/provisioning-worker-runtime.ts`) foi
extraído de `provisioning-worker.ts` especificamente para isso: recebe o `SecretStore` (e o
logger) do chamador em vez de construí-los internamente, para que `provisioning-worker.ts`
(processo isolado) e `dev-full.ts` (processo combinado) montem exatamente o mesmo pipeline a
partir de instâncias diferentes — sem duplicar a composição. Testado diretamente
(`src/workers/provisioning-worker-runtime.test.ts`): um `TenantDatabaseConnectionManager`
construído a partir do **mesmo** `SecretStore` que o worker usou resolve e conecta com
sucesso; construído a partir de um `SecretStore` **diferente**, falha com
`TenantSecretNotFoundError` — nunca recorrendo à credencial administrativa.
`createMediaOutboxDispatcherRuntime()` (`src/workers/media-outbox-dispatcher-runtime.ts`, Prompt
031) e `createMediaProcessingWorkerRuntime()` (`src/workers/media-processing-worker-runtime.ts`,
Prompt 032) seguem exatamente o mesmo padrão de extração, pela mesma razão: os dois precisam
resolver credencial de aplicação por tenant (para abrir cada Tenant Data Plane), então herdam o
mesmo gap de `SecretStore` entre processos que o worker de provisionamento já tem —
`provisioning-dispatcher.ts`, por não tocar credencial de tenant nenhuma (só Control Plane +
Redis), permanece deliberadamente fora de `dev-full.ts` (seção "Media outbox dispatcher" acima
detalha o porquê).

`dev-full.ts` recusa-se a iniciar sob `NODE_ENV=production` com seu próprio fail-fast
explícito (não depende só do guard interno do `InMemorySecretStore`) — este runtime **não
representa a topologia de produção** e nunca deve ser usado como se representasse. Os cinco
entrypoints independentes (`server.ts`, `provisioning-worker.ts`, `provisioning-dispatcher.ts`,
`media-outbox-dispatcher.ts`, `media-processing-worker.ts`) continuam existindo, inalterados em
intenção — eles continuam não compartilhando `SecretStore` entre si quando executados
separadamente, e essa é uma limitação documentada, não corrigida por este runtime combinado (que
é uma conveniência local temporária, não uma correção da arquitetura real). `dev-full.ts` deixa
de ser necessário quando o Prompt de ADR-004 (AWS Secrets Manager) for implementado.

Fluxo local recomendado para testar `POST/GET /api/v1/properties` manualmente via Swagger
(ver também README.md):

```bash
docker compose up -d
pnpm db:migrate
pnpm dev:dispatcher     # terminal separado — continua processo independente
pnpm dev:full           # API + provisioning worker, SecretStore compartilhado
```

**IMPLEMENTED** (Prompt 024) — `bootstrapLocalDevCluster()`
(`src/main/dev-full-bootstrap.ts`) closes the manual-bootstrap gap above, for `dev-full.ts`
specifically. Called once at `dev-full.ts` startup, before `app.listen()`:

```text
dev-full.ts startup
    ↓
createInMemorySecretStore()  (fresh, empty — every process restart)
    ↓
bootstrapLocalDevCluster(secretStore, logger, { clusterName, host, port, adminUsername, adminPassword })
    ├── database_clusters row for TENANT_DATABASE_DEFAULT_CLUSTER: insert only if missing
    │   (onConflictDoNothing on the unique name — idempotent by discovery, CLAUDE.md; never
    │   overwrites an already-existing row, so a locally-customized one is never reset)
    └── secretStore.put(cluster.secretReference, {username, password}): unconditional, every
        call — the SecretStore itself never survives a restart even though the
        database_clusters row does, so this is what actually re-closes the gap each time
    ↓
POST /api/v1/tenants → provisioning succeeds without any manual step
```

Connection details come from four new **dev-only** env vars, read exclusively by
`dev-full.ts` — `DEV_BOOTSTRAP_CLUSTER_HOST`/`_PORT`/`_ADMIN_USERNAME`/`_ADMIN_PASSWORD`
(all optional, defaulting to `postgres-tenants`'s Docker Compose values). `server.ts`,
`provisioning-worker.ts` and `provisioning-dispatcher.ts` never read them and never call
`bootstrapLocalDevCluster()` — running them as separate processes still requires the
`database_clusters` row and admin secret to be seeded manually, exactly as before this Prompt;
this task changes nothing about production behavior or about any entrypoint other than
`dev-full.ts`. Proven end to end
(`src/main/dev-full-bootstrap.test.ts`): after only `bootstrapLocalDevCluster()` (no other
manual step), `POST /api/v1/tenants` through the real HTTP app provisions a real tenant
database and the tenant reaches `READY`.

## Transactional Outbox **(futuro)**

Padrão planejado para publicar eventos de forma confiável a partir de operações
transacionais (ex.: mudanças de estado que precisam disparar jobs assíncronos). Ainda não
implementado.

## Object Storage — Cloudflare R2

**Object storage provider: Cloudflare R2** (ver
[ADR-006](adr/ADR-006-cloudflare-r2-object-storage.md)).

**IMPLEMENTED** (Prompt 026; `getObject` acrescentado no Prompt 032) — `ObjectStorage` port
(`src/infrastructure/object-storage/object-storage.ts`): `putObject`/`getObject`/`deleteObject`,
tipos independentes de provider (`PutObjectInput`/`StoredObject`/`GetObjectResult`), e
`validateObjectKey` (rejeita key vazia, começando com `/`, ou com um segmento `..`) —
compartilhado por qualquer adapter futuro, não só o do R2. `getObject` materializa o corpo
inteiro em `Buffer` (nunca stream — o original já é limitado a 10MB no upload, Prompt 027) e
classifica falhas de forma provider-agnostic: `ObjectStorageObjectNotFoundError` (permanente) vs
`ObjectStorageReadError` (transitório) — o adapter R2 é quem sabe traduzir o erro real do SDK
(`NoSuchKey`/404) para essa distinção, nunca o chamador. Domínio/aplicação dependem só desta
porta; `@aws-sdk/client-s3` nunca vaza para fora do adapter.

**IMPLEMENTED** (Prompt 026) — adapter real
(`createCloudflareR2ObjectStorage`, `src/infrastructure/object-storage/cloudflare-r2-object-storage.ts`),
via `@aws-sdk/client-s3`:

```text
config (accountId/accessKeyId/secretAccessKey/bucket/publicUrl)
    ↓
resolveConfig (Zod) — todos os 5 campos obrigatórios aqui, mesmo sendo opcionais em env.ts
    → incompleto/inválido → ObjectStorageConfigurationError (nomeia só os campos, nunca valores)
    ↓
S3Client({ region: "auto", endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
           credentials, forcePathStyle: false })
    ↓
putObject → PutObjectCommand (Bucket/Key/Body/ContentType/ContentLength, nunca ACL)
deleteObject → DeleteObjectCommand (idempotente por semântica nativa do S3)
```

`publicUrl` retornado por `putObject` é `R2_PUBLIC_URL` + key, com normalização de barra (nunca
`//` nem barra ausente) — nunca descoberto via API da Cloudflare, sempre a base configurada.
Erros do provider nunca vazam credencial/endpoint/request bruto — mapeados para
`ObjectStorageUploadError`/`ObjectStorageDeleteError`, causa original preservada só em `.cause`
para debug interno.

**Env vars** (`.env.example`) — todas opcionais no parse global de `env.ts` (nenhum processo
hoje falha por falta de R2 só por causa disso), mas exigidas como conjunto completo dentro de
`createCloudflareR2ObjectStorage` (falha explícita em configuração parcial, nunca aceita
silenciosamente): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
`R2_PUBLIC_URL`.

**IMPLEMENTED** (Prompt 027) — `server.ts`/`dev-full.ts` agora constroem o adapter R2 real
eagerly, no startup, antes de `app.listen()` — nunca lazily no primeiro upload. Configuração R2
incompleta/ausente faz esses dois entrypoints se recusarem a subir (`logger.fatal` + `process.exit(1)`,
confirmado manualmente: mensagem nomeia só os campos ausentes, nunca um valor). `provisioning-worker.ts`/
`provisioning-dispatcher.ts` continuam inalterados — nunca dependem de R2. Sem guard de
`NODE_ENV`, ao contrário do `InMemorySecretStore` — R2 é provider real, válido em qualquer
ambiente já configurado (ADR-006).

**IMPLEMENTED** (Prompt 027) — `property_media` (Tenant Data Plane, migration
`drizzle/tenant/0003_add_property_media.sql`, `schemaVersion` 3→4), metadados apenas — os
binários ficam inteiramente no R2. Sem `tenant_id` (ADR-001). Colunas: `id`, `property_id` (FK
→ `properties.id`, `ON DELETE/UPDATE RESTRICT` — properties nunca são fisicamente deletadas,
então cascade nunca teria gatilho real; RESTRICT é a escolha conservadora), `object_key`
(`UNIQUE`, nunca exposto na resposta HTTP — detalhe interno), `public_url` (persistido no
upload, nunca recalculado no GET), `mime_type` (`CHECK` restrito às 3 mesmas mime types
validadas em `ALLOWED_PROPERTY_MEDIA_MIME_TYPES`), `size_bytes` (`bigint`/modo `number`),
`original_filename` (nullable, basename sanitizado — nunca um path), `position` (inteiro,
`UNIQUE(property_id, position)` — formaliza a ordem da galeria e serve `listByProperty()` sem
índice adicional), `is_cover` (boolean, `NOT NULL DEFAULT false`; Prompt 028, migration
`drizzle/tenant/0004_add_property_media_cover.sql`, `schemaVersion` 4→5) — no máximo uma capa
por propriedade, garantido por um índice único parcial
(`property_media_one_cover_per_property`, `UNIQUE(property_id) WHERE is_cover = true`), nunca só
por lógica de aplicação; a primeira mídia enviada para uma propriedade vira capa automaticamente,
decidido dentro da mesma transação/lock que calcula `position` — nunca uma segunda query
separada que poderia correr, timestamps.

```text
POST /api/v1/properties/:id/media   (multipart/form-data, campo "file", 1 arquivo, ≤10MB)
    ↓
validar property existe no tenant + status != INACTIVE (senão 404/409)
    ↓
validar MIME declarado (allowlist: image/jpeg, image/png, image/webp)
    ↓
validar magic bytes do conteúdo contra o MIME declarado (nunca confia só no header/extensão)
    ↓
gerar mediaId (UUID) + object key: tenants/<tenantId>/properties/<propertyId>/<mediaId>.<ext>
    (IDs técnicos só — nunca filename/título/endereço/nome/email do cliente)
    ↓
ObjectStorage.putObject()   ← nunca dentro de uma transação PostgreSQL (CLAUDE.md)
    ↓
INSERT property_media, position = MAX(position)+1 dentro de uma transação que faz
    SELECT ... FOR UPDATE na própria linha de properties (this task, seção 16) — serializa
    uploads concorrentes para a mesma property sem lock global/advisory separado
    ↓ (falha)
compensação best-effort: ObjectStorage.deleteObject() — ver ADR-007 para a estratégia completa
    de consistência entre R2 e PostgreSQL (sem transação distribuída)

GET /api/v1/properties/:id/media   → position ASC, id ASC; INACTIVE permanece legível
    (archive nunca esconde mídia)
```

`@fastify/multipart` registrado escopado dentro do próprio plugin de rotas de properties (nunca
globalmente em `build-app.ts`) — `limits: { fileSize: 10MB, files: 1 }`. Corpo multipart nunca
tem `schema.body` no Fastify (AJV validaria `undefined` contra um schema de objeto e rejeitaria
todo upload real — verificado empiricamente) — documentado via `consumes` + descrição da rota +
o schema `UploadPropertyMediaRequest` registrado (visível no Swagger, não linkado como
`requestBody` formal).

Ver [ADR-007](adr/ADR-007-property-media-consistency.md) para a estratégia completa de
consistência R2/PostgreSQL (upload primeiro, insert depois, compensação best-effort).

**IMPLEMENTED** (Prompt 028) — gerenciamento da galeria sobre a fundação do Prompt 027:

```text
PUT /api/v1/properties/:id/media/order   {media_ids: [uuid, ...]}
    ↓
lock property (SELECT ... FOR UPDATE), depois substitui a ordem inteira da galeria — media_ids
    precisa ser exatamente o conjunto atual de mídias da propriedade (nem menos, nem mais, sem
    duplicatas); id desconhecido/de outra propriedade → 404, contagem não bate → 409, lista
    vazia só é aceita como no-op se a propriedade já não tem mídia (senão 409). Reindexação usa
    um offset temporário dentro da transação (soma N a todas as posições, depois atribui os
    valores finais 0..N-1 um a um) para nunca colidir com `UNIQUE(property_id, position)`
    durante a operação. Nunca altera `is_cover`.

PATCH /api/v1/properties/:id/media/:mediaId/cover   (sem corpo)
    ↓
lock property → valida que a mídia pertence à propriedade (senão 404) → remove is_cover=true de
    quem tinha antes → marca a nova, tudo em uma transação. Idempotente: selecionar a capa atual
    de novo ainda retorna 200.

DELETE /api/v1/properties/:id/media/:mediaId   (sem corpo)
    ↓
ordem oposta ao upload (ver ADR-007 "Delete"): remove a metadata primeiro, dentro de uma
    transação com lock de linha, reindexa as posições restantes para 0..N-1 gapless e promove a
    mídia da nova posição 0 a capa (só se a mídia removida era a capa e ainda restam outras);
    só depois do commit tenta remover o objeto real em R2, best-effort — uma falha aí nunca
    derruba a resposta HTTP (sempre 204), é logada com segurança (bucket/key/mediaId, nunca
    segredo) e vira preocupação de reconciliação futura, nunca implementada nesta tarefa. Se a
    transação PostgreSQL falhar, `ObjectStorage.deleteObject()` nunca chega a ser chamado.
```

Todas as três rotas continuam permitidas para propriedades arquivadas (`INACTIVE`) — só o
upload de mídia nova é bloqueado por arquivamento; reorder/capa/exclusão são manutenção da
galeria existente. `object_key` continua nunca exposto em nenhuma resposta HTTP.

**PLANNED** (fora do escopo até aqui): image resizing/thumbnails, compressão, conversão
WebP/AVIF, CDN custom domain, signed URLs, upload multipart-direto browser→R2, upload em lote,
reconciliação de objetos órfãos no R2 (worker/processo agendado — Prompt 028 documenta o
problema em ADR-007 "Delete" e no CLAUDE.md, mas não implementa a reconciliação em si).

**PLANNED / DESIGNED** (Prompt 029) — arquitetura de processamento assíncrono de imagens,
decidida em [ADR-008](adr/ADR-008-asynchronous-property-image-processing.md). Nenhum
processamento de imagem real foi decidida ali; a implementação real veio no Prompt 032 (ver
abaixo) — `sharp` está instalado e em uso desde então.

**IMPLEMENTED** — a arquitetura completa de processamento assíncrono de mídia, ponta a ponta:

```text
Property media processing status  = IMPLEMENTED  (property_media.processing_status)
Property media variants schema    = IMPLEMENTED  (property_media_variants)
Media processing outbox intent    = IMPLEMENTED  (outbox_events, dentro da transação do upload)
BullMQ media-processing contract  = IMPLEMENTED  (queue/job/payload + retry/backoff, Prompt 032)
Media outbox dispatcher           = IMPLEMENTED  (Prompt 031 — ver ADR-009)
Cross-tenant discovery            = IMPLEMENTED  (Prompt 031 — TenantDiscovery, ver ADR-009)
Sharp image processing            = IMPLEMENTED  (Prompt 032 — ver abaixo)
Media processing worker           = IMPLEMENTED  (Prompt 032 — ver abaixo)
THUMBNAIL/CARD/DETAIL generation  = IMPLEMENTED  (Prompt 032)
Media variant HTTP exposure       = PLANNED
Orphan reconciliation             = PLANNED
```

```text
POST .../media (inalterado desde o Prompt 027/028)
    ↓
ObjectStorage.putObject() — original no R2, fora de qualquer transação PostgreSQL (CLAUDE.md)
    ↓
transação PostgreSQL única (Tenant Data Plane):
    INSERT property_media (processing_status = PROCESSING, explícito, nunca o default da coluna)
    INSERT outbox_events   (aggregate_type=PROPERTY_MEDIA, aggregate_id=mediaId,
                             event_type=PROPERTY_MEDIA_PROCESSING_REQUESTED,
                             payload={propertyId, mediaId})
    ↓ (commit — os dois juntos, ou nenhum dos dois)
HTTP termina (201) — nenhuma chamada a BullMQ acontece aqui (this task, section 48)
```

`property_media.processing_status` (enum `PROCESSING`/`READY`/`FAILED`, migration
`drizzle/tenant/0005_add_media_processing_status_and_variants.sql`, `schemaVersion` 5→6) — nunca
sobre o original em si (que já é servível via `public_url` em qualquer estado), só sobre suas
variantes derivadas. Toda mídia nova é inserida como `PROCESSING` explicitamente pelo código de
aplicação (`upload-property-media.ts`/`drizzle-property-media-repository.ts`); o default da
coluna (`READY`) existe apenas para o backfill de linhas anteriores a esta migration — mídias já
válidas sob o modelo anterior, que nunca devem parecer quebradas por não terem variantes ainda
(provado empiricamente: `tenant-data-plane.test.ts` aplica as migrations 0000-0004, insere uma
linha crua, depois aplica a 0005 e confirma `processing_status = 'READY'`). `FAILED` já era um
valor alcançável do enum desde o Prompt 030, mas só o worker de processamento real (Prompt 032,
ver abaixo) efetivamente transiciona uma linha para ele.

`property_media_variants` (mesma migration) — colunas `id`/`property_media_id` (FK
`ON DELETE CASCADE`, diferente do `RESTRICT` de `property_media.property_id` — uma variant não
tem valor independente, é inteiramente reproduzível a partir do original)/`variant` (enum
`THUMBNAIL`/`CARD`/`DETAIL`)/`object_key` (`UNIQUE`)/`public_url`/`mime_type` (texto livre,
deliberadamente não restrito a `image/webp` — seção 14 do Prompt 030)/`width`/`height`
(`CHECK > 0` ambos)/`size_bytes` (`CHECK > 0`)/timestamps, `UNIQUE(property_media_id, variant)` —
o mecanismo de idempotência que o worker de processamento depende (upsert sobre essa constraint
— `PropertyMediaProcessingRepository.finalizeReady()`, Prompt 032, ver abaixo — nunca um insert
simples). Sem `tenant_id` (ADR-001). Nenhum repository dedicado existia para esta tabela no
Prompt 030 (deliberado — seção 57 daquela tarefa: sem consumidor real ainda); os testes de
constraint originais daquele momento (`drizzle-property-media-repository.test.ts`) seguem
inserindo diretamente através do objeto de tabela do Drizzle, mas o Prompt 032 acrescentou o
repository real que o worker usa (`property-media-processing-repository.ts`).

**Media processing outbox intent**: em vez de uma tabela de jobs nova, o upload reaproveita
`outbox_events` — já existente em todo Tenant Data Plane desde a primeira migration — como a
intenção persistente e transacional de processar uma mídia (Prompt 030, seções 40/49). Isso
evita exatamente o problema de dual-write PostgreSQL+Redis que o provisionamento já resolveu de
outra forma (dispatcher + lease, ADR-002): o upload HTTP nunca chama `queue.add()` diretamente
— só grava a intenção no mesmo banco/transação da mídia. `outbox_events.processed_at` não era
marcado por nada no Prompt 030 — desde o Prompt 032, o worker de processamento (ver abaixo) o
marca ao final de um `finalizeReady`/`finalizeFailed` bem-sucedido.

**BullMQ media-processing contract** (`src/infrastructure/queue/media-processing-queue.ts`) —
fila `media-processing`, job `process-property-media`, payload mínimo validado por Zod
(`tenantId`/`propertyId`/`mediaId`, todos UUID, `.strict()` — nunca credenciais, URL pública ou
bytes). `createMediaProcessingQueue()` ganhou (Prompt 032) `defaultJobOptions` configuráveis
(`attempts`/`backoff` exponencial) — nenhum consumer existia no Prompt 030; o Prompt 032
implementou o worker real (ver abaixo).

- Original sempre preservado no R2, indefinidamente — reprocessamento futuro (nova qualidade,
  novo preset, correção de algoritmo) não exige novo upload do usuário.
- Nenhuma mudança de comportamento HTTP no Prompt 030 além do novo campo `processing_status` na
  resposta de `PropertyMedia`: `POST .../media` continua exatamente como no Prompt 027/028;
  `property_media.object_key` de mídia já existente (formato `.../<mediaId>.<ext>`, sem
  subpasta) permanece válido — variantes futuras usam o prefixo `.../<mediaId>/`, sem exigir
  reorganização de keys existentes. Nenhuma rota nova; `property_media_variants` não é exposta
  em nenhuma resposta HTTP ainda.

**IMPLEMENTED** (Prompt 031) — dispatcher multi-tenant de outbox de mídia, arquitetura completa
em [ADR-009](adr/ADR-009-multi-tenant-outbox-dispatch.md). Resolve a pendência que o Prompt 030
havia registrado (como consumir `outbox_events` espalhado por um database físico por tenant, sem
um loop ingênuo varrendo todo tenant database conhecido):

```text
Control Plane
    ↓
TenantDiscovery.listReadyTenantIds({ after: cursor, limit: tenantBatchSize })
    — tenants.status=READY AND tenant_databases.status=READY AND database_clusters.status=ACTIVE,
      ordenado por tenants.id ASC, cursor em memória (nunca persistido — perder o cursor apenas
      reinicia a varredura; a fonte de verdade é o outbox pendente de cada tenant, não o cursor)
    ↓ (até MEDIA_OUTBOX_DISPATCH_CONCURRENCY tenants em paralelo por ciclo)
para cada tenant elegível:
    TenantDatabaseResolver.resolve(tenantId) — revalidado a cada ciclo, nunca cacheado
    ↓
    TenantDatabaseConnectionManager.withTenantDatabase(target, ...)
    ↓
    claim: SELECT ... FOR UPDATE SKIP LOCKED (aggregate_type=PROPERTY_MEDIA,
        event_type=PROPERTY_MEDIA_PROCESSING_REQUESTED, não despachado/processado/falho,
        lease ausente ou expirado) LIMIT eventBatchSize, ORDER BY created_at ASC, id ASC (FIFO)
    ↓ (commit — transação curta, nunca aberta durante a chamada ao BullMQ)
    para cada evento: valida payload (Zod) →
        inválido  → dispatch_failed_at + dispatch_error (mensagem fixa, nunca payload/stack)
        válido    → queue.add(jobId = outbox_events.id) → sucesso: dispatched_at
                                                          → falha: releaseLease (retry imediato)
```

`outbox_events` ganhou (migration `drizzle/tenant/0006_add_outbox_dispatch_metadata.sql`,
`schemaVersion` 6→7) `dispatch_claimed_at`/`dispatch_lease_until`/`dispatched_at`/
`dispatch_failed_at`/`dispatch_error` — mesma forma exata das colunas de dispatch de
`provisioning_jobs` (ADR-002), deliberadamente genérica (nem a constraint nem o índice parcial
fazem referência a `aggregate_type`/`event_type` — esse filtro vive só na query do dispatcher,
CLAUDE.md: nenhuma tabela de outbox media-specific). `jobId = outbox_events.id` (nunca um UUID
novo por tentativa) é o que torna uma redelivery segura — provado com Redis real: uma falha de
confirmação simulada seguida de uma nova tentativa produz exatamente um job no BullMQ, nunca
dois. `dispatched_at` (confirmação de transporte) permanece estritamente distinto de
`processed_at` (conclusão de processamento de domínio, nunca escrito por este dispatcher) — ver
ADR-009 para o raciocínio completo.

Isolamento de falha em duas camadas: por evento (uma falha de `publish()` libera o lease e não
impede os próximos eventos do mesmo tenant) e por tenant (um tenant temporariamente inacessível —
secret ausente, cluster `INACTIVE`, timeout — é registrado e pulado, nunca aborta o ciclo
inteiro). Novo módulo `src/modules/media-processing/` (aplicação + infraestrutura) e
`src/modules/tenant-runtime/{application,infrastructure}/tenant-discovery.ts` (descoberta,
reutilizável por qualquer dispatcher cross-tenant futuro). Entrypoint standalone
`src/workers/media-outbox-dispatcher.ts` (`pnpm dev:media-dispatcher`/`start:media-dispatcher`) —
mas, como este dispatcher precisa resolver credencial de aplicação de cada tenant (diferente do
dispatcher de provisionamento, que só toca Control Plane + Redis), ele herda o mesmo gap de
`SecretStore` entre processos já documentado para `provisioning-worker.ts` vs `server.ts` (ver
"Local development runtime" abaixo) — `pnpm dev:full` agora também compõe este runtime,
compartilhando a mesma `SecretStore` em memória que o worker de provisionamento já usa, fechando
o gap localmente.

**IMPLEMENTED** (Prompt 032) — worker real de processamento de imagens com `sharp`, consumindo a
fila `media-processing` publicada pelo dispatcher acima. Arquitetura completa registrada em
[ADR-008](adr/ADR-008-asynchronous-property-image-processing.md) (atualizada de
PLANNED/DESIGNED para implementação real por esta tarefa):

```text
BullMQ (job process-property-media, jobId = outbox_events.id)
    ↓
Media Processing Worker (src/modules/media-processing/infrastructure/bullmq-media-processing-worker.ts)
    ↓
job.id validado como UUID (= outboxEventId) + job.data revalidado pelo mesmo schema Zod do
    dispatcher — nunca confia apenas na validação já feita lá
    ↓
TenantDatabaseResolver.resolve(tenantId) → TenantDatabaseConnectionManager.withTenantDatabase
    ↓
PropertyMediaProcessingRepository.loadContext({outboxEventId, propertyId, mediaId})
    ready              → segue abaixo
    already-processed  → no-op (replay idempotente de um job já concluído)
    media-missing       → markObsoleteProcessed(outboxEventId) — mídia deletada após o enqueue,
                          nunca um erro
    invalid-event       → finalizeFailed(...) — outbox/mídia inconsistentes entre si (defensivo,
                          inalcançável pelo fluxo normal), erro permanente
    ↓ (ready)
ObjectStorage.getObject(objectKey) — baixa o original
    ObjectStorageObjectNotFoundError → finalizeFailed (permanente)
    qualquer outro erro                → propaga (transitório, BullMQ decide o retry)
    ↓
ImageVariantProcessor.process(buffer) — sharp (ver abaixo)
    UnsupportedPropertyMediaError → finalizeFailed (permanente)
    qualquer outro erro            → propaga (transitório)
    ↓
para cada variante (sequencial, nunca paralelo — evita 3 encode+upload simultâneos):
    ObjectStorage.putObject(key determinística, ver seção "Storage layout" do ADR-008)
    ↓
PropertyMediaProcessingRepository.finalizeReady({outboxEventId, mediaId, variants})
    — UMA transação: upsert das 3 variantes (UNIQUE(property_media_id, variant),
      onConflictDoUpdate) + property_media.processing_status = READY +
      outbox_events.processed_at = now() — READY nunca observável sem as variantes que o
      justificam, provado com rollback forçado real (drizzle-property-media-processing-repository.test.ts)
    media-missing → limpa (best-effort) as variantes recém-enviadas ao R2, nunca recria a mídia
```

**Sharp image processing** (`src/modules/media-processing/infrastructure/sharp-image-variant-processor.ts`)
— `sharp` (dependência direta única desta tarefa) confinado inteiramente a este arquivo; o port
(`image-variant-processor.ts`) e todo consumidor nunca o importam diretamente. Presets
centralizados: `THUMBNAIL` 320px, `CARD` 640px, `DETAIL` 1280px (largura máxima), sempre WebP
qualidade 82, `withoutEnlargement: true` (nunca amplia um original menor), aspect ratio sempre
preservado (resize só por largura, sem `fit`/crop). `.rotate()` sem argumento aplica a
orientação EXIF nos pixels antes de descartar toda a metadata (nunca `.withMetadata()` — GPS/
câmera/dados pessoais nunca sobrevivem numa variante pública). `limitInputPixels` (env
`MEDIA_PROCESSING_MAX_INPUT_PIXELS`, default 40.000.000px) aplicado em toda chamada `sharp()` —
guarda contra decompression bombs, nunca dependente só do limite de 10MB em bytes do upload.
`metadata().pages > 1` rejeita imagem animada/multi-página explicitamente (nunca processa
silenciosamente só o primeiro frame). Qualquer falha de decode/transform/limite vira
`UnsupportedPropertyMediaError` (nunca um tipo de erro do `sharp` vazando para fora do adapter)
— testado com Node 22/Windows local e confirmado em CI (Linux) via `pnpm test` normal, incluindo
um teste real de pixel-limit e um teste real de auto-orientação (fixtures geradas em memória
via `sharp({create: ...})`, nunca um binário externo).

**Object storage `getObject`** (`src/infrastructure/object-storage/object-storage.ts`,
`cloudflare-r2-object-storage.ts`) — porta evoluída com `getObject(key): Promise<GetObjectResult>`
(`{body: Buffer, contentType?, contentLength?}`, materializado inteiro em memória — nunca stream,
seção 18 do Prompt 032, aceitável dado o limite de 10MB do original). Erros classificados no
adapter, nunca vazando forma de SDK: `ObjectStorageObjectNotFoundError` (S3 `NoSuchKey`/404 —
provider-agnostic, permanente) vs `ObjectStorageReadError` (qualquer outra falha — transitório).
`InMemoryObjectStorage` (test-support) evoluiu junto, mesma semântica.

**Retry/backoff configurável** (`src/config/env.ts`) —
`MEDIA_PROCESSING_JOB_ATTEMPTS` (default 5) e `MEDIA_PROCESSING_JOB_BACKOFF_MS` (default 5000,
exponencial) configurados uma vez em `createMediaProcessingQueue()`'s `defaultJobOptions` (nunca
inventados depois pelo worker) — diferente do `attempts: 1` explícito da fila de provisionamento
(ADR-002, que delega toda recuperação ao seu próprio execution lease). Na última tentativa
configurada, se o erro ainda for transitório, o worker tenta persistir `FAILED` +
`outbox_events.processed_at` ele mesmo antes de deixar o job falhar definitivamente — nunca uma
mídia presa em `PROCESSING` para sempre só porque R2/PostgreSQL ficaram indisponíveis por tempo
demais. Uma falha permanente (classificada) vira `UnrecoverableError` do BullMQ imediatamente,
sem esperar as tentativas configuradas se esgotarem.

`MEDIA_PROCESSING_WORKER_CONCURRENCY` (default 2) — nunca reaproveita a concorrência do worker
de provisionamento (workload de CPU, não de I/O).

**Delete atualizado** (Prompt 032, seção 64-67) — `DELETE .../media/:mediaId` agora também
remove, best-effort, toda variante já gerada, não só o original: o repository lê os
`object_key` das variantes (`property_media_variants`) *antes* do `DELETE` que dispara o
`ON DELETE CASCADE`, e a camada de aplicação tenta remover cada key (original + variantes)
independentemente — uma falhando nunca impede a tentativa das outras (ADR-007 "Delete").

Novo módulo `src/modules/media-processing/` ganhou `domain/property-media-processing-error.ts`
(`UnsupportedPropertyMediaError`) e os arquivos de `application`/`infrastructure` acima.
`src/modules/properties/domain/property-media-variant.ts` (novo) define `PropertyMediaVariantName`
e a key determinística (`buildPropertyMediaVariantObjectKey`) reutilizada pelo worker.

Entrypoint standalone `src/workers/media-processing-worker.ts`
(`pnpm dev:media-worker`/`start:media-worker`) — mesma limitação de `SecretStore` entre
processos que o dispatcher de outbox de mídia (precisa resolver credencial de tenant), mesmo
fail-fast em produção, e exige Cloudflare R2 totalmente configurado no startup (nunca lazy no
primeiro job) — `pnpm dev:full` agora também compõe este runtime, compartilhando a mesma
`SecretStore`.

**Fora do escopo do Prompt 032** (deliberado): exposição HTTP das variantes (`processing_status`
já era exposto desde o Prompt 030; URLs de `THUMBNAIL`/`CARD`/`DETAIL` continuam PLANNED),
reconciliação de objetos órfãos no R2 (originais e variantes — continua PLANNED, keys
determinísticas reduzem o impacto mas não eliminam o problema), `processing_version`/
reprocessamento sob demanda.

## Princípios

- Simplicidade: sem abstrações antecipadas, sem microserviços, sem event sourcing/CQRS sem
  necessidade concreta.
- Modularidade: regras de negócio isoladas de HTTP, PostgreSQL, Redis, filas e serviços
  externos — sem transformar isso em uma arquitetura excessivamente abstrata.
- Configuração centralizada, validada com Zod, com falha rápida na inicialização.
- Logging estruturado (Pino), nunca `console.log`, nunca segredos em log.
