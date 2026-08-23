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

- API HTTP: implementada (`src/main/server.ts`).
- Workers: **(futuro)** — serão adicionados quando a primeira fila de negócio (BullMQ) for
  necessária, com seu próprio entrypoint, sem abrir porta HTTP.

## Control Plane

Banco PostgreSQL central responsável pela operação global do SaaS: tenants, planos,
assinaturas, billing, clusters de database, databases de tenants, jobs de provisioning.

**IMPLEMENTED** — schema inicial e migrations
(`src/infrastructure/database/control-plane/schema.ts`,
`drizzle/control-plane/`):

- `tenants` — identidade do tenant (`slug` único, `status`).
- `database_clusters` — clusters PostgreSQL disponíveis, com `provider`/`region` e uma
  `secret_reference` (ponteiro para a credencial, nunca a credencial em si).
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

**PLANNED** — código do dispatcher, worker, `DatabaseProvisioner` (execução real de
`CREATE DATABASE`) e criação de registros em `tenant_databases`. Nenhum desses existe ainda;
apenas a decisão arquitetural que os orienta está registrada.

**PLANNED** — planos, assinaturas e billing ainda não possuem tabelas. `database_clusters`,
`tenant_databases` e `provisioning_jobs` existem como schema, mas nenhum código lê ou
escreve nelas: não há repositories, services nem endpoints para essas tabelas.

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

Redis está disponível localmente (Docker Compose) e as bibliotecas `ioredis`/`bullmq` estão
instaladas. Nenhuma fila de negócio foi criada ainda — serão adicionadas conforme
funcionalidades específicas exigirem processamento assíncrono.

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
