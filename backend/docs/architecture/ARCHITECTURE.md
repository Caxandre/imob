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

**IMPLEMENTED** — worker de provisionamento e máquina de estado
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
DatabaseProvisioner.provision() (porta, sem implementação real)
    ↓
sucesso → SUCCEEDED, finished_at        falha → FAILED, finished_at, error_message
```

Idempotente diante de redelivery do BullMQ: job já `SUCCEEDED`/`FAILED` não é reprocessado;
job já `RUNNING` não é reexecutado concorrentemente (recovery de `RUNNING` abandonado é
lacuna conhecida, não resolvida). `FAILED` é estado terminal nesta fase — sem retry
automático, nem do workflow nem do BullMQ (`attempts: 1` explícito na publicação).

**Segurança de runtime**: uma implementação real de `DatabaseProvisioner` já existe (Prompt
017 — ver mais abaixo), mas **não está conectada** a este worker: fazer isso exige estender a
finalização (`markSucceeded`) para persistir `ProvisioningResult` em `tenant_databases` e
ativar o tenant, fora do escopo daquela tarefa (ADR-003 "Finalization"). O entrypoint de
produção (`src/workers/provisioning-worker.ts`) **recusa-se a iniciar**, com log e saída
explícitos, em vez de rodar sem finalização real — isso impediria que jobs reais fossem
marcados `SUCCEEDED` sem `tenant_databases`/tenant `READY` nunca serem registrados. Toda a
infraestrutura ao redor (BullMQ `Worker`, repository, use case) está implementada e testada
com um `DatabaseProvisioner` fake apenas em testes.

**IMPLEMENTED (documentation)** — a arquitetura de provisionamento do database físico do
tenant está decidida em [ADR-003](adr/ADR-003-tenant-database-provisioning.md):

```text
worker (application layer)
    ↓
DatabaseProvisioner.provision() (real, futuro) — infraestrutura externa, nunca escreve no Control Plane
    ↓
DatabaseClusterSelector → cluster
    ↓
CREATE_ROLE → SAVE_CREDENTIALS → CREATE_DATABASE → RUN_MIGRATIONS → HEALTH_CHECK
    ↓
retorna ProvisioningResult (clusterId, databaseName, secretReference, schemaVersion)
    ↓
worker persiste REGISTER_DATABASE — transação única: tenant_databases + tenant READY + provisioning_job SUCCEEDED
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

**PLANNED** — `SecretStore` de produção, criação de registros em `tenant_databases`,
ativação do tenant (`tenants.status = READY`), recovery de jobs `RUNNING` abandonados,
política de retry para jobs `FAILED`. `DatabaseProvisioner` real está **IMPLEMENTED** — ver
abaixo.

**PLANNED** — planos, assinaturas e billing ainda não possuem tabelas. `database_clusters`,
`tenant_databases` e `provisioning_jobs` existem como schema, mas nenhum código lê ou
escreve nelas: não há repositories, services nem endpoints para essas tabelas.

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

`DatabaseProvisioner.provision()` (`process-provisioning-job.ts`) mudou de `Promise<void>`
para `Promise<ProvisioningResult>` — mudança mínima para compilar; `processProvisioningJob`
continua descartando o valor de retorno (`await provisioner.provision(...)`), e a máquina de
estado do worker permanece exatamente a mesma (`markSucceeded`/`markFailed` inalterados).
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

**PLANNED** — integração deste `DatabaseProvisioner` ao worker (o entrypoint de produção
continua se recusando a iniciar), finalização transacional (`tenant_databases` + tenant
`READY` + `provisioning_job SUCCEEDED`), recovery de jobs `RUNNING` abandonados, política de
retry para jobs `FAILED`. Nenhum desses existe ainda; apenas a decisão arquitetural está
registrada (ADR-003 "Finalization").

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

Estado atual: apenas a infraestrutura local (`postgres-tenants` no Docker Compose) está
disponível. Nenhum provisioning dinâmico de databases existe ainda.

## Resolução de tenant **(futuro)**

Fluxo planejado para determinar qual database físico atender por requisição:

```text
Request
   ↓
Authentication
   ↓
Tenant Context
   ↓
Tenant Registry
   ↓
Database Resolver
   ↓
Connection Manager
   ↓
Tenant Database
```

Nenhuma parte desse fluxo existe ainda. Em particular:

- **Tenant Registry (futuro)**: mapeamento de qual tenant vive em qual database/cluster,
  mantido no Control Plane. As tabelas que sustentarão esse mapeamento
  (`tenant_databases`, `database_clusters`) já existem, mas nenhum código de leitura,
  resolução ou cache foi implementado.
- **Tenant Resolver (futuro)**: resolve a identidade do tenant a partir do contexto
  autenticado da requisição — nunca a partir de parâmetros informados livremente pelo
  cliente (`databaseName`, `databaseUrl`, etc.).
- **Tenant Connection Manager (futuro)**: gerencia pools de conexão por tenant/database,
  incluindo cache e ciclo de vida de conexões.

## Redis / BullMQ

Redis está disponível localmente (Docker Compose) e no CI. **IMPLEMENTED**: a fila
`tenant-provisioning` (`src/infrastructure/queue/`), alimentada pelo dispatcher de
provisionamento e consumida por um `Worker` BullMQ real
(`src/modules/provisioning/infrastructure/bullmq-provisioning-worker.ts`). Publicação sem
retry automático (`attempts: 1` explícito) — o workflow de provisionamento não reinventa
sua política de retry no BullMQ. **PLANNED**: o entrypoint de produção do worker ainda se
recusa a iniciar — um `DatabaseProvisioner` real existe (Prompt 017), mas conectá-lo exige a
finalização transacional ainda não implementada (ver seção Control Plane).

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
