# ADR-002: Dispatcher persistente PostgreSQL → BullMQ para provisionamento de tenant

## Status

Aceito.

## Contexto

A criação de um tenant já persiste, de forma atômica, dentro de uma única transação
PostgreSQL do Control Plane (ver `POST /api/v1/tenants`):

```text
tenants           (status PROVISIONING)
provisioning_jobs (type CREATE_DATABASE, status PENDING, attempts 0)
```

O passo seguinte do workflow — de fato criar o database do tenant — precisa ser executado
de forma assíncrona, fora do ciclo de requisição HTTP. A stack já prevê BullMQ/Redis para
esse propósito (instalado, sem filas de negócio ainda).

Não existe transação distribuída entre PostgreSQL e Redis. Um `provisioning_job` já commitado
no PostgreSQL não tem, por si só, nenhuma garantia de que uma entrada correspondente exista
ou venha a existir no BullMQ.

## Problema

> Como garantir entrega confiável de um `provisioning_job` persistido no PostgreSQL para
> execução assíncrona no BullMQ sem depender de transação distribuída?

Dois fluxos ingênuos são inseguros:

```text
COMMIT PostgreSQL → queue.add()
```

O processo pode morrer entre as duas operações: o job fica commitado no Postgres mas nunca
chega ao BullMQ, e nada localiza esse job novamente — a menos que exista, em algum lugar,
um processo capaz de reconsultar o Postgres e descobrir que o job ainda não foi entregue.

```text
queue.add() → COMMIT PostgreSQL
```

O Postgres pode sofrer rollback depois que o job já existe no Redis — BullMQ passaria a
acreditar que deve executar um provisionamento para um tenant que, oficialmente, nunca
existiu.

## Decisão

`provisioning_jobs` é a **fonte persistente de verdade** do workflow de provisionamento.
BullMQ é **mecanismo de execução e transporte assíncrono**, não fonte de verdade. Um
**dispatcher** — processo separado, sem estado em memória entre execuções — lê jobs
elegíveis do PostgreSQL e os publica no BullMQ:

```text
PostgreSQL provisioning_jobs (PENDING)
        ↓
Dispatcher (polling, batch limitado, idempotente)
        ↓
BullMQ (jobId = provisioning_jobs.id)
        ↓
Provisioning Worker
```

A exclusão ou perda de um job no Redis nunca apaga a intenção persistida no PostgreSQL — o
Postgres continua sendo a verdade recuperável mesmo que o Redis perca dados, seja reiniciado
ou fique temporariamente indisponível.

Esta tarefa define a arquitetura. **Nenhum código do dispatcher, worker, fila ou migration é
criado aqui.**

## State model

### Estados atuais são insuficientes para o dispatcher

O enum atual (`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`) descreve o **workflow de
provisionamento em si**, mas não distingue, dentro de `PENDING`, se um job:

- nunca foi visto pelo dispatcher; ou
- já foi publicado no BullMQ e está apenas aguardando o worker começar.

Essa distinção é necessária para que o dispatcher saiba quais jobs ainda precisa publicar,
sem depender de nenhuma memória local.

### Decisão: não adicionar um estado `QUEUED` ao enum

Um estado `QUEUED` misturaria uma preocupação de **infraestrutura de entrega** (o dispatcher
já tentou publicar) dentro da coluna `status`, que deve continuar representando somente o
**workflow de provisionamento** (`current_step`, `attempts` e `status` são todos
responsabilidade do worker — ver seções abaixo). Alterar um enum PostgreSQL também é mais
rígido de reverter que adicionar uma coluna nullable.

### Proposta (não implementada nesta tarefa): coluna `dispatched_at`

```text
provisioning_jobs.dispatched_at  TIMESTAMPTZ NULL
```

Semântica: "o dispatcher reivindicou este job para uma tentativa de publicação", não
"o Redis confirmou o recebimento". Combinações resultantes:

| `status`    | `dispatched_at` | Significado                                              |
| ----------- | ---------------- | --------------------------------------------------------- |
| `PENDING`   | `NULL`            | Nunca visto pelo dispatcher — elegível para publicação.   |
| `PENDING`   | definido          | Publicado (ou tentativa em andamento); worker ainda não começou. |
| `RUNNING`   | definido          | Worker efetivamente executando.                            |
| `SUCCEEDED` | definido          | Concluído.                                                  |
| `FAILED`    | definido          | Falha terminal do provisionamento (não do dispatch).       |

Query conceitual de elegibilidade do dispatcher (não implementada agora):

```sql
SELECT id FROM provisioning_jobs
WHERE status = 'PENDING'
  AND (dispatched_at IS NULL OR dispatched_at < now() - interval '<redispatch_threshold>')
ORDER BY created_at
LIMIT <N>
FOR UPDATE SKIP LOCKED;
```

O limiar de "stale" (`redispatch_threshold`) cobre tanto falha do dispatcher entre publicar
e persistir quanto falha ao publicar (Redis indisponível) — ver Cenários de falha, B e C.

### Quem atualiza o quê

- **Dispatcher**: escreve somente `dispatched_at`. Nunca escreve `status`, `attempts` ou
  `current_step`.
- **Worker (futuro)**: transiciona `status` (`PENDING → RUNNING → SUCCEEDED|FAILED`),
  incrementa `attempts` e escreve `current_step`. Nunca escreve `dispatched_at`.

Essa separação impede que uma falha de infraestrutura de transporte (dispatch) seja
confundida com uma falha do provisionamento real.

## Idempotência

`jobId` do BullMQ = `provisioning_jobs.id` (o UUID já existente, sem necessidade de gerar
outro identificador).

Efeito pretendido: se o dispatcher repetir `queue.add(...)` para o mesmo `provisioning_job`
— por reinício, crash ou reprocessamento do lote de "stale" — o BullMQ não deve criar um
segundo trabalho lógico para o mesmo job; a chamada repetida deve resolver para o job já
existente.

Duas ressalvas a documentar (não resolvidas nesta tarefa, apenas registradas para quando o
dispatcher for implementado):

1. Depois que um job é removido do BullMQ (concluído e limpo pela política de
   `removeOnComplete`, ou removido manualmente), um novo `queue.add()` com o mesmo `jobId`
   cria um job **novo** com aquele id — a proteção contra duplicação só vale enquanto o job
   ainda existe no Redis. Isso é aceitável porque o dispatcher só reconsidera jobs com
   `status = 'PENDING'`; um job já `SUCCEEDED` nunca volta a ser selecionado.
2. Um `jobId` que já falhou terminalmente no BullMQ não é automaticamente "ressuscitado" por
   uma nova chamada de `add()` com o mesmo id — a política exata de retry/cleanup no BullMQ
   (`removeOnFail`, `attempts` da própria fila, etc.) é uma decisão de implementação futura,
   fora do escopo desta ADR.

## Concorrência entre dispatchers

Técnica escolhida (não implementada agora): `SELECT ... FOR UPDATE SKIP LOCKED` sobre o lote
de jobs elegíveis, dentro de uma transação curta que apenas seleciona e marca
`dispatched_at`. É apropriada porque:

- é o padrão idiomático do PostgreSQL para múltiplos consumidores de uma "fila" baseada em
  tabela, sem lock global nem coordenação externa;
- `SKIP LOCKED` evita que um dispatcher bloqueie esperando outro liberar linhas já
  reivindicadas — cada instância simplesmente pega o próximo lote disponível;
- não exige nenhuma dependência nova (é PostgreSQL puro).

Restrição importante já registrada em `ARCHITECTURE.md`/ADR-001 e reforçada aqui: a
transação PostgreSQL que faz o `SELECT FOR UPDATE SKIP LOCKED` + `UPDATE dispatched_at`
deve ser curta e **nunca deve permanecer aberta durante a chamada ao Redis**
(`queue.add()`). O `UPDATE dispatched_at` commita antes da tentativa de publicação, não
depois. Consequência aceita: `dispatched_at` marca uma **tentativa reivindicada**, não uma
confirmação de entrega — se o `queue.add()` falhar depois do commit, o job permanece
`PENDING` e será reconsiderado pelo próprio mecanismo de "stale" descrito no state model,
não por um rollback da marcação.

## Cenários de falha (crash scenarios)

### A — job PENDING, dispatcher nunca rodou

Uma execução futura do dispatcher encontra o job (`dispatched_at IS NULL`) na consulta
normal de elegibilidade e o publica. Caso base do design; nenhum tratamento especial.

### B — dispatcher publica no BullMQ, processo morre antes de atualizar o PostgreSQL

`dispatched_at` nunca foi commitado (a atualização acontece antes da chamada ao Redis, então
esse cenário só ocorre se o processo morrer entre o commit do `UPDATE` e o retorno da
`queue.add()` — nesse caso `dispatched_at` já está commitado, mas ainda é "recente"). A
próxima execução do dispatcher, ao varrer jobs "stale" (`dispatched_at` antigo, `status`
ainda `PENDING`), tenta publicar novamente. Como o `jobId` é determinístico, essa nova
tentativa não cria um segundo trabalho lógico no BullMQ (ver Idempotência).

### C — Redis indisponível

`queue.add()` falha. O `UPDATE dispatched_at` já commitado (se a marcação ocorreu antes da
tentativa) mantém o job como candidato à próxima varredura de "stale"; se a marcação para
esse lote específico ainda não tinha sido commitada, o job simplesmente permanece elegível
na consulta normal. Em ambos os casos, o PostgreSQL preserva o job pendente inalterado — a
indisponibilidade do Redis não apaga nem corrompe o registro. O dispatcher deve tratar a
falha de publicação de um job como não fatal para o restante do lote (não implementado
agora, apenas registrado como requisito).

### D — BullMQ tem o job, worker ainda não executou

`status` permanece `PENDING` (o dispatcher nunca escreve `status`); `dispatched_at` está
definido. O PostgreSQL nunca afirma que o provisionamento está em execução até que o worker,
de fato, comece a trabalhar e transicione para `RUNNING`.

### E — worker inicia, processo morre

Fora do escopo desta ADR implementar a recuperação (isso pertence ao futuro
`DatabaseProvisioner`/worker), mas o comportamento esperado é registrado aqui: o mecanismo
de *stalled jobs* do próprio BullMQ (lock de processamento expira quando o worker some;
o job stalled é reenfileirado e reprocessado, dentro do limite de tentativas configurado na
fila) é responsável por acionar uma nova tentativa de execução. Do lado do PostgreSQL, isso
deixa um risco real e explicitamente **não resolvido nesta ADR**: um job pode ficar
`RUNNING` indefinidamente se o BullMQ também esgotar suas tentativas sem que o worker jamais
tenha atualizado o status para um estado terminal. Registrado como pendência para a
implementação do worker (possível necessidade de um `started_at` com verificação de
staleness análoga a `dispatched_at`, ou de um processo de reconciliação).

## Recovery

Depois de um restart, o dispatcher não carrega nenhum estado local: a primeira ação de cada
execução é consultar o PostgreSQL pelos jobs elegíveis (`status = 'PENDING'` e
`dispatched_at` ausente ou expirado). A aplicação nunca depende de memória de processo para
saber o que falta processar — toda a informação necessária já está no Control Plane.

## Retry semantics

Duas noções distintas, que não devem ser confundidas nem compartilhar o mesmo contador:

- **Retry de dispatch** (falha ao publicar no Redis/BullMQ): pode ocorrer quantas vezes for
  necessário — cada ciclo de polling é, por natureza, uma nova tentativa. Não incrementa
  `provisioning_jobs.attempts`. Não tem política de "número máximo de tentativas de
  dispatch" nesta decisão; o limite prático é o intervalo de polling em si.
- **Retry de provisioning** (falha durante a criação/configuração real do database): possui
  política própria, ainda a ser definida (limite de tentativas, backoff), e incrementa
  `provisioning_jobs.attempts` a cada tentativa real de execução.

### `attempts`

Concordo com a preferência registrada no prompt desta tarefa:

> `attempts` representa tentativas reais de execução do provisionamento, não tentativas de
> publicar no BullMQ.

Justificativa: `attempts` existe para eventualmente orientar uma política de limite/backoff
sobre a operação que tem efeitos colaterais reais e custosos (criar database, credenciais,
migrations) — é essa operação que precisa de um orçamento de tentativas. Tentativas de
dispatch são, em comparação, baratas, idempotentes e uma preocupação de infraestrutura de
transporte; misturá-las corromperia o orçamento de retry da operação que de fato importa.

### `current_step`

Reservado exclusivamente para o estágio do provisionamento em si (`CREATE_DATABASE`,
`CREATE_CREDENTIALS`, `RUN_MIGRATIONS`, `HEALTH_CHECK`, ...), escrito apenas pelo worker.
Nunca representa estado do dispatcher.

## Alternativas consideradas

### A — `queue.add()` após `COMMIT`, sem registro persistente re-consultável

Rejeitada como mecanismo isolado: se o processo morre entre o `COMMIT` e o `queue.add()`, o
job se perde silenciosamente — nada no PostgreSQL sinaliza que ele ainda precisa ser
entregue. A decisão adotada (D) também publica *depois* do commit, mas a diferença crítica é
que o estado que habilita a publicação (`status = PENDING`) é durável e continuamente
reconsultável; a entrega deixa de depender de uma única tentativa "e se falhar, perdeu".

### B — `queue.add()` antes do `COMMIT`

Rejeitada: se a transação do PostgreSQL sofrer rollback depois, o BullMQ já teria um job
publicado para uma entidade que oficialmente nunca existiu (tenant e/ou provisioning_job
desfeitos). Também acopla uma chamada de rede mais lenta e menos confiável (Redis) como
pré-requisito dentro de uma transação de banco — o mesmo princípio já adotado na transação
de criação de tenant (ADR/implementação anterior): nenhuma operação externa dentro de uma
transação PostgreSQL.

### C — tabela `outbox_events` separada

Avaliada e rejeitada por ora. O padrão *transactional outbox* clássico existe para permitir
que múltiplos tipos de evento, de múltiplas tabelas de negócio, compartilhem um único
mecanismo de relay genérico — tipicamente uma tabela de envelopes de evento, descartados
após a publicação. `provisioning_jobs` já cumpre esse papel para o único workflow assíncrono
existente hoje: já é o registro de negócio durável (não um envelope descartável), já possui
um identificador estável para uso como `jobId`, e já possui um campo de status para filtrar
elegibilidade. Criar uma tabela genérica adicional, sem um segundo consumidor concreto,
seria abstração antecipada. Se um segundo workflow assíncrono não relacionado a
provisioning surgir futuramente com a mesma necessidade, vale reavaliar um outbox genérico
naquele momento — não agora.

### D — `provisioning_jobs` como fonte persistente + dispatcher

**Aceita.** É a estratégia descrita nesta ADR.

### E — transação distribuída PostgreSQL + Redis

Rejeitada como irrealista para este projeto. Redis não implementa um protocolo de
compromisso de duas fases (2PC) compatível com participantes XA; não há forma padrão e
confiável de coordenar um commit atômico entre PostgreSQL e Redis. Mesmo que fosse possível
via alguma solução não padrão, o custo de acoplamento, latência e novas classes de falha
(coordenador de transação como ponto único de falha adicional) seria desproporcional ao
problema real, que já é inteiramente resolvido por entrega "pelo menos uma vez" com
publicação idempotente — a garantia que este projeto de fato precisa, não "exactly-once"
transacional.

## Relação com Transactional Outbox

Esta decisão é melhor descrita como um **outbox especializado** (specialized transactional
outbox) aplicado diretamente sobre a tabela de domínio `provisioning_jobs`, em vez de um
"persistent job dispatcher" genérico com uma tabela própria de transporte. O mecanismo é o
mesmo do outbox clássico — persistir a intenção transacionalmente, retransmitir de forma
assíncrona e idempotente — mas sem a tabela de envelope genérica adicional, porque
`provisioning_jobs` já é, ao mesmo tempo, o registro de domínio e a fonte de elegibilidade
de entrega.

## Consequências

- Nenhuma migration é criada nesta tarefa. A coluna `dispatched_at` (e a query de
  elegibilidade que depende dela) é uma necessidade real identificada, a ser implementada
  quando o dispatcher for construído.
- O worker (futuro) precisa ser escrito com a separação de responsabilidades definida aqui:
  ele é o único escritor de `status`, `attempts`, `current_step`, `started_at` e
  `finished_at`; o dispatcher é o único escritor de `dispatched_at`.
- A recuperação do cenário E (worker morre em execução, BullMQ esgota tentativas) permanece
  uma lacuna conhecida e não resolvida — deve ser endereçada explicitamente quando o worker
  for implementado, não assumida como automaticamente coberta por este ADR.
- Nenhuma tabela `outbox_events` genérica será criada enquanto o provisionamento de tenant
  for o único workflow assíncrono do sistema.

## Future implementation notes

Registrado para a tarefa que implementar o dispatcher/worker, sem comprometer detalhes de
implementação nesta ADR:

- Migration futura: `ALTER TABLE provisioning_jobs ADD COLUMN dispatched_at timestamptz
  NULL;` (aditiva, sem quebra de compatibilidade).
- Intervalo de polling e tamanho de lote (`LIMIT N`) devem ser configuráveis via variável de
  ambiente validada em `config/env.ts`, não hardcoded.
- Nenhum scheduler externo (cron, Kafka) — o próprio dispatcher com polling interno é
  suficiente para a escala atual.
- O limiar de "stale" para redispatch (usado tanto na recuperação de crash quanto na
  recuperação de falha do Redis) precisa de um valor inicial razoável, a ser definido na
  implementação, não nesta decisão.
