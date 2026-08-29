# ADR-009: Multi-Tenant Outbox Dispatch

## Status

Aceito. Implementação: **IMPLEMENTED** (Prompt 031) — descoberta de tenants via Control Plane,
claim/lease por Tenant Data Plane, transporte determinístico para BullMQ. Nenhum worker de
processamento de imagem existe ainda (ADR-008 continua PLANNED/DESIGNED para isso).

## Context

O Prompt 030 (ADR-008) decidiu que o upload de mídia registra sua intenção de processamento
atomicamente em `outbox_events` — uma tabela já existente em cada Tenant Data Plane — em vez de
chamar `queue.add()` (BullMQ) diretamente a partir do request HTTP. Isso evita o dual-write
frágil PostgreSQL+Redis, mas deixa em aberto exatamente como esse evento persistido chega até o
BullMQ de fato.

O problema tem uma dimensão que o dispatcher de provisionamento (ADR-002) nunca precisou
resolver: `provisioning_jobs` vive inteiramente no Control Plane — um único database. Já
`outbox_events` vive dentro de cada Tenant Data Plane — um database físico por tenant (ADR-001).
Não existe hoje (e não deveria existir, ver "Alternatives considered") um único `SELECT` capaz de
enxergar todo evento de outbox pendente em todos os tenants ao mesmo tempo. Um dispatcher
multi-tenant precisa primeiro descobrir *quais* databases olhar antes de poder aplicar qualquer
protocolo de claim/lease dentro de cada um.

## Decision

**Descoberta via Control Plane, claim/lease dentro de cada Tenant Data Plane, transporte para
BullMQ fora de qualquer transação PostgreSQL — mesmo protocolo de três passos do dispatcher de
provisionamento (ADR-002), aplicado uma vez por tenant a cada ciclo.**

```text
Control Plane
    ↓
TenantDiscovery.listReadyTenantIds({ after: cursor, limit: tenantBatchSize })
    — tenants.status=READY AND tenant_databases.status=READY AND database_clusters.status=ACTIVE
    ↓ (até `concurrency` tenants em paralelo por vez)
para cada tenantId:
    TenantDatabaseResolver.resolve(tenantId)   — revalidado a cada ciclo, nunca cacheado
    ↓
    TenantDatabaseConnectionManager.withTenantDatabase(target, ...)
    ↓
    claim: SELECT ... FOR UPDATE SKIP LOCKED LIMIT eventBatchSize, depois UPDATE
           (dispatch_claimed_at, dispatch_lease_until) — transação curta, commit
    ↓
    para cada evento reclamado: valida payload (Zod) → queue.add() (fora da transação) →
        markDispatched() (dispatched_at) ou markDispatchFailed() (payload inválido) ou
        releaseLease() (falha de publish)
```

## Architecture

### Tenant discovery

`TenantDiscovery.listReadyTenantIds({ after, limit })`
(`src/modules/tenant-runtime/application/tenant-discovery.ts`,
`.../infrastructure/drizzle-tenant-discovery.ts`) — um único `SELECT` com `INNER JOIN` sobre
`tenants`/`tenant_databases`/`database_clusters`, filtrando exatamente as mesmas três condições
que `TenantDatabaseResolver.resolve()` já verifica para um único tenant: `tenants.status =
READY`, `tenant_databases.status = READY`, `database_clusters.status = ACTIVE`. Ordenado por
`tenants.id ASC`, paginado por um cursor exclusivo (`after`) — nunca um `OFFSET`, que degradaria
com o crescimento da tabela e poderia pular/repetir linhas sob escrita concorrente.

**Cursor em memória, nunca persistido** (this task, seção 7): perder o cursor (reinício do
processo) apenas reinicia a varredura da lista de tenants elegíveis do zero no próximo ciclo —
isso nunca perde trabalho, porque a fonte de verdade do que falta processar é o conjunto de
linhas pendentes em cada `outbox_events`, não a posição do cursor em si. Um ciclo que retorna uma
página completa (`length === tenantBatchSize`) avança o cursor para o último id retornado; uma
página incompleta significa que o fim da lista de tenants elegíveis foi alcançado — o próximo
ciclo reinicia do começo.

### Outbox claim/lease (dispatch metadata)

`outbox_events` ganhou (migration `drizzle/tenant/0006_add_outbox_dispatch_metadata.sql`, Tenant
Data Plane apenas):

```text
dispatch_claimed_at   timestamptz nullable
dispatch_lease_until  timestamptz nullable
dispatched_at         timestamptz nullable
dispatch_failed_at    timestamptz nullable
dispatch_error        text nullable
```

Mesma forma exata das colunas de dispatch de `provisioning_jobs` (ADR-002) — incluindo a mesma
constraint (`dispatch_lease_until IS NULL OR dispatch_claimed_at IS NOT NULL`, nunca um lease sem
o claim que o originou) e o mesmo índice parcial ordenado por `created_at, id` sobre exatamente o
predicado de elegibilidade do dispatcher. Deliberadamente **genérico** — nem a constraint nem o
índice fazem qualquer referência a `aggregate_type`/`event_type`: esta tabela continua um outbox
reutilizável por qualquer evento futuro, não uma tabela de jobs de mídia (CLAUDE.md, regra desta
tarefa). O filtro `aggregate_type = PROPERTY_MEDIA AND event_type =
PROPERTY_MEDIA_PROCESSING_REQUESTED` vive inteiramente na query do dispatcher
(`drizzle-media-outbox-dispatch-repository.ts`), nunca no schema.

**Claim**: dentro de uma transação curta por tenant, `SELECT ... FOR UPDATE SKIP LOCKED LIMIT
eventBatchSize` sobre os eventos elegíveis (não despachados, não processados, não permanentemente
falhos, lease ausente ou expirado), ordenado por `created_at ASC, id ASC` (FIFO); em seguida um
`UPDATE` define `dispatch_claimed_at`/`dispatch_lease_until` para os ids retornados, e a
transação comita. `FOR UPDATE SKIP LOCKED` é o que permite duas instâncias concorrentes do
dispatcher (ou dois tenants do mesmo ciclo, se algum dia compartilhassem conexão) reclamarem lotes
disjuntos em vez de colidir na mesma linha — comprovado empiricamente
(`drizzle-media-outbox-dispatch-repository.test.ts`: duas chamadas concorrentes de
`claimEligibleEvents` nunca reclamam o mesmo evento).

### Queue.add fora da transação

`queue.add()` só é chamado **depois** que a transação de claim já comitou — nunca dentro dela
(CLAUDE.md: nunca manter uma transação PostgreSQL aberta durante uma operação externa como
Redis/BullMQ). Se `queue.add()` tiver sucesso, `markDispatched()` grava `dispatched_at` (um
segundo `UPDATE`, guardado por `dispatched_at IS NULL` para nunca sobrescrever uma confirmação já
existente). Se `queue.add()` falhar, `releaseLease()` limpa apenas `dispatch_lease_until` — mantém
`dispatch_claimed_at` para observabilidade, mesmo princípio já usado pelo dispatcher de
provisionamento (ADR-002, Step 5) — deixando o evento imediatamente reclamável de novo, sem
esperar o lease expirar por si.

### Deterministic jobId (idempotência entre claim e confirm)

`jobId = outbox_events.id` — nunca um UUID novo a cada tentativa de publish. Se o dispatcher
falhar exatamente entre o `queue.add()` ter sucesso e o `markDispatched()` comitar (um crash de
processo, uma falha transitória de PostgreSQL nesse instante específico), o evento permanece sem
`dispatched_at` e será reclamado de novo em um ciclo futuro; a nova tentativa chama `publish()`
outra vez com o **mesmo** `jobId`. BullMQ resolve isso para o job existente (ou trata como no-op
se esse job já tiver sido concluído e removido) em vez de criar uma segunda unidade lógica de
trabalho — provado empiricamente com Redis real
(`dispatch-media-outbox-events.e2e.test.ts`: uma falha de confirmação simulada seguida de uma
segunda tentativa de dispatch produz exatamente **um** job no BullMQ, nunca dois).

### `dispatched_at` vs `processed_at`

Distinção deliberada e central desta tarefa (seção 21/22):

```text
processed_at = null, dispatched_at = null       → ainda não transportado
processed_at = null, dispatched_at != null      → transportado, aguardando o worker
processed_at != null                            → processamento de domínio concluído
```

`processed_at` significa que um consumidor de domínio (o futuro worker de `sharp`, ADR-008)
terminou de processar o evento — nunca que o transporte até a fila teve sucesso. Este dispatcher
**nunca escreve `processed_at`** — ele só confirma transporte (`dispatched_at`). Misturar os dois
conceitos permitiria a um evento "desaparecer" da visão do dispatcher (achando que já foi
processado) sem que nenhum trabalho de domínio real tivesse ocorrido.

### Payload inválido

O payload de `outbox_events.payload` é `jsonb` — um boundary não confiável do ponto de vista de
quem lê, mesmo sendo esta mesma base de código a única que já escreveu nele até hoje. Cada evento
claimed é validado por Zod
(`propertyMediaProcessingRequestedPayloadSchema`, `{propertyId, mediaId}`, ambos UUID, `.strict()`)
antes de qualquer chamada a `queue.add()`. Um payload que falha essa validação é um erro
permanente, nunca transitório — nenhuma quantidade de retry o torna válido. Em vez de deixá-lo
preso para sempre em "pendente" (o que causaria um loop de reclaim infinito a cada ciclo) ou
reaproveitar `processed_at` para significar "descartado por erro" (confundindo transporte com
processamento de domínio, ver seção acima), o dispatcher marca `dispatch_failed_at` +
`dispatch_error` (mensagem fixa e segura, nunca o payload bruto/stack — this task, seção 28:
"Invalid PROPERTY_MEDIA_PROCESSING_REQUESTED payload") e nunca chama `queue.add()` para esse
evento. O índice parcial de elegibilidade já exclui `dispatch_failed_at IS NOT NULL`, então o
evento nunca mais é reclamado.

### Failure isolation

Duas camadas de isolamento, nunca deixando uma falha local derrubar o ciclo inteiro:

- **Por evento** (`dispatchTenantMediaOutboxOnce`): uma falha de `publish()` para um evento
  específico é capturada, resulta em `releaseLease()` (best-effort) e não impede os próximos
  eventos do mesmo tenant de serem processados no mesmo lote.
- **Por tenant** (`runMediaOutboxDispatchCycleOnce`): uma falha ao resolver ou conectar a um
  tenant específico (secret ausente, cluster `INACTIVE`, timeout de conexão, ...) é capturada e
  registrada como `tenant-unavailable` — nunca propagada para abortar o restante do ciclo. Um
  tenant temporariamente indisponível é simplesmente tentado de novo no próximo ciclo.

`TenantDatabaseResolver.resolve()` é chamado a cada ciclo, nunca cacheado entre ciclos — Control
Plane pode mudar entre a descoberta e a tentativa de dispatch (um tenant suspenso, um cluster
desativado), e o resolver sempre revalida do zero, mesma disciplina já documentada nele próprio.

### Fairness

`eventBatchSize` limita quantos eventos um único tenant pode ter processados por ciclo — um
tenant com milhares de eventos pendentes nunca monopoliza um ciclo às custas de outro tenant com
apenas um evento pendente, porque cada tenant é uma consulta/transação completamente
independente, isolada por database físico (ADR-001). `concurrency` limita quantos tenants são
processados em paralelo por vez, via um agrupamento simples em lotes (`Promise.all` por chunk) —
nenhuma dependência nova para isso (this task, seção 34).

### Configuration

Novas variáveis de ambiente, todas opcionais com default (`src/config/env.ts`,
`.env.example`):

```text
MEDIA_OUTBOX_DISPATCH_TENANT_BATCH_SIZE = 25
MEDIA_OUTBOX_DISPATCH_EVENT_BATCH_SIZE  = 20
MEDIA_OUTBOX_DISPATCH_POLL_INTERVAL_MS  = 5000
MEDIA_OUTBOX_DISPATCH_CONCURRENCY       = 5
MEDIA_OUTBOX_DISPATCH_LEASE_SECONDS     = 30
```

## SecretStore/runtime implications

Diferente do dispatcher de provisionamento (`provisioning-dispatcher.ts`), que só toca Control
Plane + Redis e por isso nunca precisou resolver credencial de tenant, este dispatcher **precisa**
abrir uma conexão real com o database de cada tenant para reivindicar/atualizar seus
`outbox_events` — o que exige resolver a credencial de aplicação daquele tenant a partir de um
`SecretStore` (`TenantDatabaseCredentialResolver`). Isso o coloca na mesma categoria do worker de
provisionamento: rodando como um processo genuinamente separado de quem quer que tenha
originalmente provisionado o tenant (e, portanto, escrito seu secret), sua própria
`InMemorySecretStore()` fresca nunca teria esse secret — toda tentativa de dispatch para qualquer
tenant real falharia com `TenantSecretNotFoundError`, isolada e logada por tenant (nunca
derrubando o processo), mas nunca despachando nada de fato.

Este não é um bug introduzido aqui — é o mesmo gap entre processos já documentado para
`provisioning-worker.ts` vs `server.ts` (ARCHITECTURE.md "Local development runtime"), e a
correção é a mesma já estabelecida: `src/main/dev-full.ts` agora também compõe o runtime deste
dispatcher (`createMediaOutboxDispatcherRuntime`), compartilhando a **mesma** instância de
`SecretStore` que o worker de provisionamento já escreve secrets de tenant nela — fechando o gap
localmente, exatamente como já faz para o worker. `provisioning-dispatcher.ts` continua
deliberadamente fora de `dev-full.ts` (nunca precisou desse compartilhamento, e não ganha um sem
necessidade). O entrypoint standalone (`src/workers/media-outbox-dispatcher.ts`) continua existindo
e é a topologia real de implantação futura, quando um `SecretStore` de produção existir (ADR-004)
e todo processo do sistema puder compartilhá-lo através desse provider em vez da memória do
processo.

## Alternatives considered

- **Uma tabela de outbox/jobs de mídia global no Control Plane**: rejeitada explicitamente
  (CLAUDE.md, regra desta tarefa) — reintroduziria o mesmo risco de dado compartilhado entre
  tenants que ADR-001 rejeitou para toda tabela de domínio, só que para infraestrutura de
  dispatch em vez de dado de negócio. `outbox_events` permanece corretamente isolado por tenant.
- **Loop ingênuo de varredura** (a cada N segundos, conectar em todo tenant database conhecido e
  fazer `poll`): rejeitado — escalaria mal (custo de conexão proporcional ao número total de
  tenants a cada ciclo, independentemente de terem trabalho pendente ou não) e foi o problema que
  ADR-008 já registrou como pendência, não uma solução. A descoberta baseada em Control Plane com
  paginação por cursor resolve isso sem inventar um mecanismo de descoberta externo.
- **Paginação por `OFFSET`**: rejeitada em favor de cursor por `tenants.id` — `OFFSET` degrada
  com o tamanho da tabela e pode pular ou repetir linhas sob escrita concorrente durante a
  varredura; um cursor por chave ordenada não tem nenhum desses problemas.
- **Persistir o cursor de tenant no Control Plane**: avaliado e rejeitado por desnecessário (seção
  7) — a fonte de verdade do trabalho pendente já vive nos próprios `outbox_events`; perder o
  cursor apenas reinicia a varredura, nunca perde uma reivindicação já feita.

## Consequences

- Toda tarefa futura que precisar de um segundo tipo de evento de outbox despachado para uma fila
  diferente pode reutilizar o mesmo padrão (`TenantDiscovery` + claim/lease genérico em
  `outbox_events` + publisher próprio) sem duplicar a lógica de descoberta multi-tenant.
- `dispatch_failed_at`/`dispatch_error` introduzem um terceiro estado terminal em `outbox_events`
  além de "pendente"/"despachado" — qualquer leitura futura de outbox precisa considerar esse
  terceiro caso, não apenas `processed_at IS NULL`.
- Nenhum worker consome a fila `media-processing` ainda — um job publicado por este dispatcher
  fica em espera indefinidamente no Redis até que o Prompt que implementar o worker de `sharp`
  (ADR-008) exista. Isso é esperado e não é uma falha desta tarefa.
