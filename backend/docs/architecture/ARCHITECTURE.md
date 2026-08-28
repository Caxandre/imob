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

**Migration**: `drizzle/tenant/0001_fancy_blackheart.sql`, puramente aditiva (nenhuma
migration no Control Plane). `schemaVersion` (contagem de `drizzle.__drizzle_migrations`)
passa de 1 para 2 em qualquer tenant database migrado a partir desta tarefa —
`runTenantMigrations()`/o provisioner aplicam-na automaticamente para tenants novos, sem
nenhuma mudança de lógica.

**PLANNED** — rollout de migration para tenant databases já existentes antes desta tarefa
(ficam parados em `schemaVersion = 1`, sem a tabela `properties`, até serem migrados
manualmente). Rodar migrations dentro de uma requisição HTTP normal é expressamente proibido
(nunca implementado, nem será) — ver `TenantDatabaseConnectionManager`, que só abre conexões,
nunca aplica DDL. Um mecanismo de rollout em lote/canário para tenants existentes é trabalho
de infraestrutura futuro, fora do escopo desta tarefa.

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
agora. Busca full-text (`q`/substring arbitrária) e busca por proximidade/geolocalização
continuam **PLANNED**, deliberadamente fora do escopo desta tarefa.

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

**IMPLEMENTED** (Prompt 021) — `src/main/dev-full.ts` (`pnpm dev:full`), um runtime **somente
de desenvolvimento** que sobe a API HTTP e o worker de provisionamento no mesmo processo,
compartilhando a mesma instância de `SecretStore`:

```text
pnpm dev:full
    ↓
uma única composição de dependências
    ↓
InMemorySecretStore compartilhado
    ├── HTTP API (build-app.ts → TenantDatabaseConnectionManager)
    └── provisioning worker (createProvisioningWorkerRuntime)
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

`dev-full.ts` recusa-se a iniciar sob `NODE_ENV=production` com seu próprio fail-fast
explícito (não depende só do guard interno do `InMemorySecretStore`) — este runtime **não
representa a topologia de produção** e nunca deve ser usado como se representasse. Os três
entrypoints independentes (`server.ts`, `provisioning-worker.ts`,
`provisioning-dispatcher.ts`) continuam existindo, inalterados em intenção — eles continuam
não compartilhando `SecretStore` entre si quando executados separadamente, e essa é uma
limitação documentada, não corrigida por este runtime combinado (que é uma conveniência local
temporária, não uma correção da arquitetura real). `dev-full.ts` deixa de ser necessário
quando o Prompt de ADR-004 (AWS Secrets Manager) for implementado.

Fluxo local recomendado para testar `POST/GET /api/v1/properties` manualmente via Swagger
(ver também README.md):

```bash
docker compose up -d
pnpm db:migrate
pnpm dev:dispatcher     # terminal separado — continua processo independente
pnpm dev:full           # API + provisioning worker, SecretStore compartilhado
```

**Limitação pré-existente, não introduzida nem resolvida por esta tarefa**: nenhum mecanismo
neste código semeia automaticamente o secret administrativo do cluster
(`database_clusters.secret_reference`) em um `SecretStore` de um processo real em execução —
todo teste que precisa dele chama `secretStore.put()` diretamente, dentro do próprio processo
de teste. Isso significa que provisionar um tenant de verdade via `pnpm dev:full`/Swagger
(`POST /api/v1/tenants` → aguardar `READY`) hoje ainda exige um passo manual adicional fora
deste código para colocar esse secret no `SecretStore` do processo em execução — uma lacuna
que já existia antes deste Prompt (nada, antes dele, permitia provisionar um tenant real fora
de um teste automatizado) e que continua fora do escopo desta tarefa resolver.

## Transactional Outbox **(futuro)**

Padrão planejado para publicar eventos de forma confiável a partir de operações
transacionais (ex.: mudanças de estado que precisam disparar jobs assíncronos). Ainda não
implementado.

## Storage S3-compatible **(futuro)**

Armazenamento de arquivos (ex.: fotos de imóveis, documentos) via um storage
S3-compatible. Ainda não implementado — nenhuma integração de storage existe no código
atual.

## Princípios

- Simplicidade: sem abstrações antecipadas, sem microserviços, sem event sourcing/CQRS sem
  necessidade concreta.
- Modularidade: regras de negócio isoladas de HTTP, PostgreSQL, Redis, filas e serviços
  externos — sem transformar isso em uma arquitetura excessivamente abstrata.
- Configuração centralizada, validada com Zod, com falha rápida na inicialização.
- Logging estruturado (Pino), nunca `console.log`, nunca segredos em log.
