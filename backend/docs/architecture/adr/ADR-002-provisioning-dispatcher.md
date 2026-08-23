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

### Revisão: separar "reivindicado" de "confirmado" (decisão explícita)

Uma revisão desta ADR identificou uma ambiguidade semântica real na proposta original: o
protocolo descrito preenchia `dispatched_at` **antes** de `queue.add()` ser sequer chamado
(no commit da transação de claim) — o que contradiz o próprio nome do campo. "Dispatched"
não pode significar "ainda não tentamos publicar".

Três abordagens foram avaliadas para corrigir isso:

- **A — manter um único campo `dispatched_at`, mudando o protocolo para só escrevê-lo após
  confirmação real do `queue.add()`.** Rejeitada: sem nenhum campo de reivindicação anterior
  à confirmação, dois dispatchers concorrentes não têm como saber que um job já está sendo
  publicado por outro processo entre o início e o fim da chamada ao Redis. A única forma de
  evitar isso sem um campo de lease seria manter a transação PostgreSQL aberta durante a
  chamada ao Redis (já rejeitado na versão original desta ADR) ou aceitar que todo ciclo de
  polling republique, sem nenhum throttle, qualquer job ainda não confirmado — mesmo os que
  já estão em andamento em outro processo. Perde exatamente a propriedade que uma
  reivindicação de curta duração oferece.
- **B — separar claim de confirmação com campos de lease/tentativa dedicados, deixando
  `dispatched_at` reservado para confirmação real.** **Escolhida.** Equivalente ao
  "visibility timeout" usado por filas baseadas em lease (SQS e a maioria das implementações
  de fila sobre PostgreSQL) — padrão bem entendido, sem introduzir dependência nova.
- **C — outra solução mínima equivalente.** Nenhuma alternativa foi identificada que
  preserve as cinco propriedades exigidas (nenhuma transação aberta durante I/O Redis;
  múltiplos dispatchers concorrentes; recuperação após crash; entrega at-least-once;
  idempotência via `jobId`) sem convergir, na prática, para o mesmo mecanismo de lease da
  opção B. C colapsa em B.

### Proposta (não implementada nesta tarefa): três colunas nullable

```text
provisioning_jobs.dispatch_claimed_at   TIMESTAMPTZ NULL  -- observabilidade: última tentativa de claim
provisioning_jobs.dispatch_lease_until  TIMESTAMPTZ NULL  -- enforcement: até quando o claim é válido
provisioning_jobs.dispatched_at         TIMESTAMPTZ NULL  -- confirmação real de publicação no BullMQ
```

Semântica de cada campo:

- **`dispatch_claimed_at`**: quando um dispatcher reivindicou este job pela última vez para
  uma tentativa de publicação. Campo de auditoria/observabilidade — não participa da lógica
  de elegibilidade.
- **`dispatch_lease_until`**: até quando essa reivindicação é considerada válida. Enquanto
  `now() < dispatch_lease_until`, nenhum outro dispatcher deve reconsiderar o job elegível.
  Depois de expirar, o job volta a ser elegível automaticamente — é o mecanismo real de
  concorrência e recuperação de crash (ver "Protocolo completo de dispatch", abaixo).
- **`dispatched_at`**: escrito **uma única vez**, somente depois que `queue.add()` retorna
  com sucesso confirmado. Nunca escrito antecipadamente. Uma vez definido, o job nunca mais
  é reconsiderado pelo dispatcher, independentemente do estado do lease.

Tabela de combinações revisada:

| `status`             | `dispatched_at` | `dispatch_lease_until` | Significado                                                                                    |
| --------------------- | ----------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `PENDING`             | `NULL`             | `NULL` ou expirado         | Elegível — nunca confirmado, sem reivindicação ativa.                                              |
| `PENDING`             | `NULL`             | válido (no futuro)         | Reivindicado por um dispatcher; publicação em andamento ou aguardando confirmação. Não elegível.   |
| `PENDING`             | definido           | (irrelevante)              | Publicação confirmada; worker ainda não começou.                                                    |
| `RUNNING`             | definido           | (irrelevante)              | Worker efetivamente executando.                                                                      |
| `SUCCEEDED`/`FAILED`  | definido           | (irrelevante)              | Terminal.                                                                                             |

Query conceitual de elegibilidade do dispatcher (não implementada agora):

```sql
SELECT id FROM provisioning_jobs
WHERE status = 'PENDING'
  AND dispatched_at IS NULL
  AND (dispatch_lease_until IS NULL OR dispatch_lease_until < now())
ORDER BY created_at
LIMIT <N>
FOR UPDATE SKIP LOCKED;
```

Mudança em relação à versão anterior: a elegibilidade não depende mais de comparar
`dispatched_at` com um limiar de "stale" — `dispatch_lease_until` assume esse papel sozinho,
e `dispatched_at IS NULL` volta a significar exatamente o que o nome diz: "ainda não
confirmado".

### Quem escreve o quê

- **Dispatcher**: escreve `dispatch_claimed_at` e `dispatch_lease_until` no momento do
  claim; escreve `dispatched_at` somente após confirmação do `queue.add()`. Nunca escreve
  `status`, `attempts` ou `current_step`.
- **Worker (futuro)**: transiciona `status` (`PENDING → RUNNING → SUCCEEDED|FAILED`),
  incrementa `attempts` e escreve `current_step`. Nunca escreve nenhum dos três campos de
  dispatch.

Essa separação impede que uma falha de infraestrutura de transporte (dispatch) seja
confundida com uma falha do provisionamento real.

## Idempotência

`jobId` do BullMQ = `provisioning_jobs.id` (o UUID já existente, sem necessidade de gerar
outro identificador).

Efeito pretendido: se o dispatcher repetir `queue.add(...)` para o mesmo `provisioning_job`
— por reinício, crash ou expiração do lease de reivindicação — o BullMQ não deve criar um
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

Múltiplas instâncias do dispatcher podem rodar simultaneamente. A segurança dessa
concorrência é responsabilidade do mecanismo de lease (`dispatch_lease_until`) definido
acima: um job só é elegível quando não está sob um lease válido, independentemente de qual
dispatcher o reivindicou por último. `SELECT ... FOR UPDATE SKIP LOCKED` continua sendo
usado no momento do claim, mas com um papel diferente do que tinha na versão original desta
ADR — ver Passo 1 do protocolo abaixo para a análise completa de por que ainda é apropriado.

## Protocolo completo de dispatch

Numerado conforme solicitado na revisão desta ADR: claim, commit da claim, `queue.add`,
confirmação, falha no `queue.add`, crash entre `queue.add` e confirmação, e
expiração/recovery de claim.

### 1. Claim

Dentro de uma transação PostgreSQL curta, o dispatcher seleciona um lote de jobs elegíveis:

```sql
BEGIN;

SELECT id FROM provisioning_jobs
WHERE status = 'PENDING'
  AND dispatched_at IS NULL
  AND (dispatch_lease_until IS NULL OR dispatch_lease_until < now())
ORDER BY created_at
LIMIT <N>
FOR UPDATE SKIP LOCKED;
```

**`FOR UPDATE SKIP LOCKED` continua necessário?** Sim, mas seu papel mudou: deixou de ser a
garantia de segurança do protocolo (essa responsabilidade agora é do lease, que sobrevive ao
fim da transação) e passou a ser uma **otimização de eficiência e distribuição de trabalho**
dentro da própria transação de claim.

- Sem ele: duas instâncias fazendo `SELECT` no mesmo instante, antes de qualquer uma
  commitar seu `UPDATE` de lease (Passo 2), poderiam ler o mesmo lote de linhas "elegíveis"
  e ambas tentar reivindicá-las. O `jobId` determinístico ainda evitaria trabalho lógico
  duplicado no BullMQ (ver Idempotência) — não seria uma falha de correção — mas seria
  desperdício: chamadas redundantes ao Redis e lotes sobrepostos em vez de trabalho
  distribuído entre instâncias.
- Com ele: cada instância que roda no mesmo instante pega um lote genuinamente disjunto das
  demais.

Ou seja: a correção do protocolo já não depende de `FOR UPDATE SKIP LOCKED` — depende do
lease e da idempotência do `jobId`. Mantê-lo continua sendo a escolha certa porque é uma
técnica padrão do PostgreSQL, sem custo de dependência nova, que evita trabalho redundante
sem exigir nenhuma coordenação externa.

### 2. Commit da claim

Ainda na mesma transação, antes de qualquer chamada ao Redis:

```sql
UPDATE provisioning_jobs
SET dispatch_claimed_at = now(),
    dispatch_lease_until = now() + interval '<lease_duration>'
WHERE id = ANY(<ids selecionados>);

COMMIT;
```

A transação termina aqui. Nenhuma chamada de rede acontece dentro dela.

### 3. `queue.add`

Fora da transação, para cada job reivindicado:

```ts
await queue.add(jobName, payload, { jobId: job.id });
```

Se essa chamada nunca for feita (por exemplo, o processo morre entre o Passo 2 e este), o
job permanece reivindicado até o lease expirar — ver Passo 7.

### 4. Confirmação no PostgreSQL

Somente depois que `queue.add()` resolve com sucesso, uma atualização mínima e independente:

```sql
UPDATE provisioning_jobs
SET dispatched_at = now()
WHERE id = <job.id>;
```

Esta é a única escrita de `dispatched_at` em todo o protocolo, e só acontece depois de uma
confirmação real. A partir daqui, o job nunca mais é reconsiderado pelo dispatcher.

Executar esta atualização duas vezes (por exemplo, se dois dispatchers, por uma corrida
anterior ao efeito do `SKIP LOCKED`, conseguirem ambos publicar com sucesso) é inofensivo:
`dispatched_at` recebe o mesmo tipo de valor duas vezes, sem duplicar linha nem corromper
estado.

### 5. Falha no `queue.add`

Se a chamada falhar de forma síncrona e observável (Redis indisponível, timeout, erro de
conexão), o dispatcher sabe, no mesmo processo, que a publicação não aconteceu. Em vez de
esperar o lease expirar naturalmente, ele libera a reivindicação imediatamente:

```sql
UPDATE provisioning_jobs
SET dispatch_lease_until = NULL
WHERE id = <job.id>;
```

Isso permite que o próximo ciclo de polling — desta ou de outra instância — tente novamente
sem esperar o tempo total do lease. `attempts` não é incrementado (é falha de dispatch, não
de provisioning — ver Retry semantics).

### 6. Crash entre `queue.add` e confirmação

Este é o cenário central que motivou a revisão. Sequência: `queue.add()` **de fato tem
sucesso** — o BullMQ já possui o job — mas o processo do dispatcher morre antes de executar
o Passo 4. Nesse momento:

- `dispatched_at` continua `NULL` no PostgreSQL, corretamente refletindo que **este processo
  não tem confirmação persistida** — mesmo que a publicação real tenha, de fato, acontecido.
- `dispatch_lease_until` continua com o valor definido no Passo 2, e vai expirar
  naturalmente.
- Quando o lease expira, o job volta a ficar elegível, e uma nova execução do dispatcher (ou
  a mesma, em um ciclo futuro) refaz os Passos 1 a 3 para o mesmo job.
- Como o `jobId` é determinístico, esse novo `queue.add()` não cria um segundo trabalho
  lógico — resolve para o job que já existe no BullMQ (contanto que ainda não tenha sido
  concluído e removido; ver Idempotência).
- O Passo 4 finalmente executa nesta segunda tentativa, e `dispatched_at` é definido — agora
  corretamente.

O ponto central a registrar explicitamente: **o sistema não tenta eliminar a incerteza sobre
se o primeiro `queue.add()` realmente teve sucesso — ele tolera essa incerteza, porque uma
nova tentativa é segura.** A garantia de "nenhum trabalho lógico duplicado" vem inteiramente
da idempotência do `jobId`, não de uma tentativa de saber com certeza o que aconteceu antes
do crash.

### 7. Expiração/recovery de claim

Não existe um processo de "sweep" ou recuperação separado. A expiração do lease é apenas
mais uma condição na mesma query de elegibilidade do Passo 1
(`dispatch_lease_until IS NULL OR dispatch_lease_until < now()`) — o mesmo código que
localiza jobs nunca reivindicados também localiza, sem lógica adicional, jobs cujo lease
expirou. Isso cobre tanto a recuperação de crash do dispatcher (Passo 6 / Cenário B abaixo)
quanto a recuperação de falha do Redis quando o dispatcher não conseguiu liberar o lease
proativamente (Passo 5 não executado por crash).

A duração do lease (`lease_duration`) precisa ser maior que o tempo esperado, no pior caso
razoável, para completar os Passos 2 a 4 — caso contrário, dispatchers concorrentes
disputariam reivindicar o mesmo job antes que uma tentativa legítima, apenas lenta, termine.
Valor não definido nesta ADR (ver Future implementation notes).

## Cenários de falha (crash scenarios)

### A — job PENDING, dispatcher nunca rodou

Coberto pelo Passo 1 do protocolo: a query de elegibilidade encontra o job
(`dispatched_at IS NULL`, sem lease ativo) na primeira vez que qualquer dispatcher roda.
Caso base do design; nenhum tratamento especial.

### B — dispatcher publica no BullMQ, processo morre antes de atualizar o PostgreSQL

Exatamente o Passo 6 do protocolo ("Crash entre `queue.add` e confirmação") — ver ali para a
análise completa.

### C — Redis indisponível

Coberto pelos Passos 5 e 7: se a falha for observável no mesmo processo, o lease é liberado
imediatamente (Passo 5); se o processo morrer antes disso, o lease expira naturalmente
(Passo 7). Em ambos os casos o job permanece `PENDING`/`dispatched_at IS NULL` no
PostgreSQL — a indisponibilidade do Redis nunca apaga nem corrompe o registro. O dispatcher
deve tratar a falha de publicação de um job individual como não fatal para o restante do
lote (não implementado agora, apenas registrado como requisito).

### D — BullMQ tem o job, worker ainda não executou

`status` permanece `PENDING` (o dispatcher nunca escreve `status`); `dispatched_at` está
definido (Passo 4 já ocorreu). O PostgreSQL nunca afirma que o provisionamento está em
execução até que o worker, de fato, comece a trabalhar e transicione para `RUNNING`.

### E — worker inicia, processo morre

Fora do escopo desta ADR implementar a recuperação (isso pertence ao futuro
`DatabaseProvisioner`/worker), mas o comportamento esperado é registrado aqui: o mecanismo
de *stalled jobs* do próprio BullMQ (lock de processamento expira quando o worker some;
o job stalled é reenfileirado e reprocessado, dentro do limite de tentativas configurado na
fila) é responsável por acionar uma nova tentativa de execução. Do lado do PostgreSQL, isso
deixa um risco real e explicitamente **não resolvido nesta ADR**: um job pode ficar
`RUNNING` indefinidamente se o BullMQ também esgotar suas tentativas sem que o worker jamais
tenha atualizado o status para um estado terminal. Registrado como pendência para a
implementação do worker (possível necessidade de um mecanismo de lease sobre `started_at`,
análogo a `dispatch_lease_until`, ou de um processo de reconciliação).

## Recovery

Depois de um restart, o dispatcher não carrega nenhum estado local: a primeira ação de cada
execução é consultar o PostgreSQL pelos jobs elegíveis (`status = 'PENDING'`,
`dispatched_at IS NULL`, sem lease válido). A aplicação nunca depende de memória de processo
para saber o que falta processar — toda a informação necessária já está no Control Plane, e
a mesma query de elegibilidade do Passo 1 serve tanto para operação normal quanto para
recovery pós-crash (ver Passo 7).

## Retry semantics

Duas noções distintas, que não devem ser confundidas nem compartilhar o mesmo contador:

- **Retry de dispatch** (falha ao publicar no Redis/BullMQ): pode ocorrer quantas vezes for
  necessário. Tem dois gatilhos possíveis — liberação proativa do lease quando a falha é
  observável no mesmo processo (Passo 5), ou expiração natural do lease quando o processo
  morre antes de reagir (Passo 7). Não incrementa `provisioning_jobs.attempts`. Não tem
  política de "número máximo de tentativas de dispatch" nesta decisão; o limite prático é o
  intervalo de polling em si.
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

- Nenhuma migration é criada nesta tarefa. As três colunas (`dispatch_claimed_at`,
  `dispatch_lease_until`, `dispatched_at`) e a query de elegibilidade que depende delas são
  uma necessidade real identificada, a ser implementada quando o dispatcher for construído.
- O worker (futuro) precisa ser escrito com a separação de responsabilidades definida aqui:
  ele é o único escritor de `status`, `attempts`, `current_step`, `started_at` e
  `finished_at`; o dispatcher é o único escritor de `dispatch_claimed_at`,
  `dispatch_lease_until` e `dispatched_at`.
- `dispatched_at`, quando implementado, deve ser escrito **somente** após confirmação real
  de `queue.add()` (Passo 4 do protocolo) — nunca no momento do claim. Este é o ponto exato
  que motivou a revisão desta ADR e deve ser preservado por qualquer implementação futura.
- A recuperação do cenário E (worker morre em execução, BullMQ esgota tentativas) permanece
  uma lacuna conhecida e não resolvida — deve ser endereçada explicitamente quando o worker
  for implementado, não assumida como automaticamente coberta por este ADR.
- Nenhuma tabela `outbox_events` genérica será criada enquanto o provisionamento de tenant
  for o único workflow assíncrono do sistema.

## Future implementation notes

Registrado para a tarefa que implementar o dispatcher/worker, sem comprometer detalhes de
implementação nesta ADR:

- Migration futura:
  ```sql
  ALTER TABLE provisioning_jobs
    ADD COLUMN dispatch_claimed_at  timestamptz NULL,
    ADD COLUMN dispatch_lease_until timestamptz NULL,
    ADD COLUMN dispatched_at        timestamptz NULL;
  ```
  Aditiva, sem quebra de compatibilidade.
- Intervalo de polling e tamanho de lote (`LIMIT N`) devem ser configuráveis via variável de
  ambiente validada em `config/env.ts`, não hardcoded.
- Nenhum scheduler externo (cron, Kafka) — o próprio dispatcher com polling interno é
  suficiente para a escala atual.
- `lease_duration` (usado no Passo 2 para calcular `dispatch_lease_until`) precisa de um
  valor inicial razoável, maior que o tempo esperado no pior caso para os Passos 2 a 4
  completarem — a ser definido na implementação, não nesta decisão.
