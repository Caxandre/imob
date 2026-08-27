# ADR-003: Provisionamento do database PostgreSQL exclusivo por tenant

## Status

Aceito.

## Contexto

O worker de provisionamento e sua máquina de estado já existem (ver ADR-002):

```text
provisioning_job PENDING → dispatcher → BullMQ → worker → RUNNING
        ↓
DatabaseProvisioner.provision()  (porta, sem implementação real)
        ↓
sucesso → SUCCEEDED        falha → FAILED
```

`DatabaseProvisioner` ainda não tem implementação concreta. Esta ADR define **como** essa
implementação deverá, no futuro, criar o database PostgreSQL exclusivo do tenant (ADR-001),
de forma idempotente e recuperável — sem implementá-la agora.

## Problema

> Como criar e registrar um database PostgreSQL exclusivo por tenant de forma idempotente,
> segura e recuperável, mesmo quando o processo falha entre etapas que não compartilham uma
> transação?

`CREATE DATABASE` não pode participar da mesma transação PostgreSQL que atualiza
`tenants`/`tenant_databases`/`provisioning_jobs` no Control Plane — são conexões e, em geral,
servidores PostgreSQL diferentes (Control Plane vs. cluster de tenants). Além disso, criar um
database, uma role, salvar uma credencial em um `SecretStore` e rodar migrations são
operações que não compartilham nenhuma transação entre si. O provisionamento é
inevitavelmente um **processo multi-etapas, não uma transação ACID única** — cada etapa deve
ser segura para repetir, e o sistema deve conseguir observar e continuar a partir de qualquer
ponto onde uma tentativa anterior parou.

## Decisão

O provisionamento é modelado como uma sequência de passos **idempotentes por descoberta**:
antes de criar qualquer recurso, o provisionador verifica se ele já existe (a partir de uma
chave estável derivada do `tenant.id`) e, se existir, reconhece e segue adiante em vez de
recriar. Nenhuma etapa depende de memória local ou de que a execução anterior tenha
terminado de forma limpa.

`tenant_databases` só é criado **depois** que o database está funcional (role, database,
migrations e health check concluídos) — até lá, `provisioning_jobs.current_step` é a única
fonte de progresso. A finalização (registrar `tenant_databases`, marcar `tenant.status =
READY` e `provisioning_job.status = SUCCEEDED`) é uma única transação atômica no Control
Plane, executada somente depois que todos os efeitos externos já foram confirmados.

Falhas parciais **não** disparam compensação destrutiva automática (sem `DROP DATABASE`/`DROP
ROLE` automático). O padrão é preservar o recurso parcial e deixar o retry idempotente
reconhecê-lo e continuar.

**Fronteira de responsabilidade (revisão pós-aprovação inicial)**: o `DatabaseProvisioner`
executa e descobre infraestrutura externa (cluster, role, secret, database, migrations,
health check) e **retorna um resultado** — ele não escreve em `tenants`, `provisioning_jobs`
nem `tenant_databases`. Quem persiste esse resultado é a camada de aplicação
(`processProvisioningJob`/worker), a mesma camada que o Prompt 009 já estabeleceu como dona
da máquina de estado (`PENDING → RUNNING → SUCCEEDED/FAILED`). A transação final
(`tenant_databases` + `tenant READY` + `provisioning_job SUCCEEDED`) é, portanto, uma
extensão dessa mesma responsabilidade já existente — não uma responsabilidade nova do
provisionador. Ver "Provisioning steps" e "Finalization" para o detalhamento.

## Resource identity

### Nome físico do database

**Nunca** derivado de `tenant.slug` (comercial, pode mudar). Derivado do `tenant.id` (UUID
técnico, estável e imutável):

```text
tenant_<uuid sem hífens, minúsculo>
```

Exemplo: `tenant.id = 3fa85f64-5717-4562-b3fc-2c963f66afa6` →
`tenant_3fa85f6457174562b3fc2c963f66afa6`.

- **Formato**: prefixo `tenant_` (7 caracteres) + 32 caracteres hexadecimais (UUID sem
  hífens) = 39 caracteres.
- **Caracteres permitidos**: `[a-z0-9_]`, exatamente o alfabeto de um identificador
  PostgreSQL não citado — nenhuma necessidade de aspas/escaping.
- **Tamanho**: 39 caracteres, bem abaixo do limite de identificador do PostgreSQL (63 bytes,
  `NAMEDATALEN`), com folga confortável.
- **Estabilidade**: fixo pela vida do tenant — nunca recalculado após a primeira derivação,
  mesmo que o slug mude.
- **Risco de colisão**: equivalente ao risco de colisão de UUID v4 (desprezível).
- **Legibilidade operacional**: um operador consegue reconhecer o padrão (`tenant_...`) e,
  removendo o prefixo e reinserindo os hífens, recuperar o `tenant.id` original para
  cruzar com o Control Plane — suficiente para diagnóstico manual sem precisar de uma tabela
  de lookup adicional.

### Nome da role

```text
tenant_<uuid sem hífens>_app
```

43 caracteres — ainda com folga sob o limite de 63. Único, estável, não depende do slug,
mesma base de derivação do nome do database (mesmo UUID), o que facilita associar
visualmente database e role no mesmo tenant.

### Identidade do secret

```text
tenant-databases/<tenant.id>
```

(mesmo padrão de path já usado por `database_clusters.secret_reference`, ex.:
`database-clusters/local-tenants`.) Um único secret por tenant nesta fase — a senha da role
de aplicação. Chave estável por `tenant.id`, nunca por slug.

## Cluster selection

Três alternativas avaliadas:

- **A — primeiro cluster `ACTIVE`**: simples, mas implícito — "primeiro" segundo qual
  ordem? Ambíguo e frágil assim que houver mais de um cluster `ACTIVE`.
- **B — cluster default configurado**: explícito, sem ambiguidade, mas sozinho seria só uma
  constante — difícil de evoluir sem tocar código de negócio diretamente.
- **C — abstração `DatabaseClusterSelector`**: permite trocar a estratégia no futuro sem
  alterar os consumidores.

**Decisão**: **C envolvendo B** como implementação inicial — uma porta pequena:

```ts
interface DatabaseClusterSelector {
  selectClusterFor(input: { tenantId: string }): Promise<{ clusterId: string }>;
}
```

A implementação inicial (não criada nesta tarefa) é determinística: busca em
`database_clusters` o cluster com `status = 'ACTIVE'` cujo `name` bate com um nome default
configurado (variável de ambiente, validada via Zod, seguindo o padrão já usado pelo
dispatcher). Nenhum algoritmo de balanceamento ou scoring nesta fase.

**Capacity (futuro)**: a seleção poderá futuramente considerar `region`, capacidade
disponível, o plano do tenant e requisito de cluster dedicado — tudo isso evolui **dentro**
da implementação de `DatabaseClusterSelector`, sem mudar o contrato do domínio
(`selectClusterFor(tenantId) → clusterId`), nem os chamadores.

## Credentials and secrets

Duas credenciais conceitualmente distintas, nunca reutilizadas uma pela outra:

- **Credencial administrativa do cluster** (`database_clusters.secret_reference`, já
  existente): usada exclusivamente pelo provisionador para `CREATE ROLE`, `CREATE DATABASE`
  e para rodar as migrations do tenant. Nunca exposta à aplicação.
- **Credencial de aplicação do tenant** (nova, referenciada por
  `tenant_databases.secret_reference`): a senha da role `tenant_<uuid>_app`. Usada, no
  futuro, pelo Connection Manager para abrir conexões em nome da aplicação — nunca pelo
  provisionador para se autenticar como admin.

Nenhuma das duas é persistida como texto no Control Plane — `secret_reference` é sempre um
ponteiro. `SecretStore` é a abstração que guarda o valor real:

```ts
interface SecretStore {
  put(path: string, value: string): Promise<void>;
  get(path: string): Promise<string | undefined>;
  delete(path: string): Promise<void>;
}
```

Nenhum provider é escolhido nesta ADR (nem AWS Secrets Manager, nem Vault). A porta permite
uma implementação local simples para desenvolvimento (ex.: arquivo local fora do controle de
versão, ou um mecanismo equivalente) e um provider real em produção, sem que o provisionador
saiba a diferença. `postgres-tenants` (Docker Compose) continua sendo o cluster local para
desenvolvimento. A implementação local **nunca** deve ser versionada nem usada em produção —
isso é reforçado pela própria existência da abstração `SecretStore`: nenhum código de
domínio ou de provisionamento pode depender de detalhes do backend local.

**Senha**: gerada com um mecanismo criptograficamente seguro (o módulo `crypto` nativo do
Node — nunca `Math.random()`). Detalhe de implementação, não decidido nesta ADR além de
excluir explicitamente geradores não criptográficos.

**Privilégios e ownership (revisado)**: a proposta original ("`CREATE DATABASE ... OWNER =
tenant_role`") foi reavaliada e trocada — dar ao tenant a posse do próprio database concede
mais privilégio do que a operação normal da aplicação precisa (posse de database inclui
poder alterar/derrubar o próprio database, alterar seus próprios privilégios, etc., mesmo
sem `SUPERUSER`). Separação adotada, com exatamente **duas** roles — nenhuma terceira role
por tenant é introduzida:

- **Credencial administrativa/provisioning do cluster** (já existente,
  `database_clusters.secret_reference`): cria database e role, é **dona** do database e de
  todos os objetos criados por migration (tabelas, sequences, etc.), e executa as
  migrations do Tenant Data Plane. Administra a estrutura; nunca é usada pela aplicação.
- **Role de aplicação do tenant** (`tenant_<uuid>_app`): apenas os privilégios necessários
  para a aplicação operar naquele database —

  ```text
  CONNECT no database
  USAGE nos schemas de aplicação (schema public por padrão — ver ADR-001; sem
    namespacing adicional por tenant dentro do próprio database, pois o isolamento já é
    no nível do database inteiro)
  SELECT, INSERT, UPDATE, DELETE nas tabelas de aplicação
  USAGE, SELECT nas sequences necessárias (colunas serial/identity)
  ```

  Sem `SUPERUSER`, sem `CREATEDB`, sem `CREATEROLE`, sem qualquer privilégio administrativo
  do cluster ou do database. A role do tenant nunca é dona de nada — apenas opera sobre
  objetos que pertencem à credencial administrativa.

**Como a role do tenant recebe privilégio sobre objetos criados por migration**: como as
migrations do Tenant Data Plane rodam como a credencial administrativa (não como a role do
tenant — ver abaixo), cada tabela/sequence nasce pertencendo ao admin. Dois mecanismos
distintos são necessários, com escopos que **não se sobrepõem**:

- **`GRANT` explícito — objetos já existentes.** `ALTER DEFAULT PRIVILEGES` **não é
  retroativo**: não concede privilégio sobre nenhum objeto que já existisse no momento em
  que foi configurado, mesmo que criado um instante antes. Se migrations já tiverem criado
  tabelas/sequences antes de `ALTER DEFAULT PRIVILEGES` estar configurado — por exemplo, um
  tenant provisionado sob uma versão anterior deste fluxo, antes dessa etapa existir — a
  única forma de cobri-las é um `GRANT` explícito sobre os objetos já existentes:

  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO <tenant_role>;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO <tenant_role>;
  ```

- **`ALTER DEFAULT PRIVILEGES` — objetos criados por migrations futuras.** Configurado
  **uma única vez**, como o primeiro statement executado no database recém-criado — **antes
  de qualquer migration do Tenant Data Plane rodar**, nunca depois:

  ```sql
  ALTER DEFAULT PRIVILEGES FOR ROLE <admin_role> IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <tenant_role>;
  ALTER DEFAULT PRIVILEGES FOR ROLE <admin_role> IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO <tenant_role>;
  ```

  Nessa ordem — configurado antes da primeira migration — toda tabela/sequence que
  qualquer migration criar dali em diante, incluindo a própria primeira, já nasce com o
  privilégio correto para a role do tenant, sem exigir `GRANT` manual repetido a cada
  migration subsequente.

Na v1, com essa ordem garantida (default privileges antes de qualquer migration), o `GRANT`
explícito acima não é necessário no caminho feliz — mas permanece documentado como o
mecanismo de recuperação para qualquer database cujo histórico não garanta essa ordem.

**Execução de migrations**: confirmado — o **admin do cluster** executa provisioning e
migrations do tenant (evita gerenciar uma segunda role de "migration" por tenant); a
**role do tenant** nunca executa migrations, só a aplicação em operação normal. Nenhuma
role adicional é introduzida nesta fase.

## Provisioning steps

Sequência final (revista a partir do rascunho conceitual do prompt — ver justificativa na
próxima seção), agora dividida explicitamente entre as duas responsabilidades:

```text
DatabaseProvisioner.provision() — infraestrutura externa, retorna um resultado, nunca escreve
no Control Plane:

1. SELECT_CLUSTER      — DatabaseClusterSelector.selectClusterFor(tenantId)
2. CREATE_ROLE         — cria ou reconhece a role tenant_<uuid>_app (sem ownership de database)
3. SAVE_CREDENTIALS    — persiste a senha no SecretStore (somente após a role já refletir essa senha)
4. CREATE_DATABASE     — cria (ou reconhece) o database, OWNER = credencial administrativa do cluster
5. RUN_MIGRATIONS      — aplica as migrations do Tenant Data Plane como a credencial administrativa
6. HEALTH_CHECK        — conecta com a credencial do tenant, executa uma query mínima

Application layer (processProvisioningJob / worker) — persiste o resultado no Control Plane:

7. REGISTER_DATABASE   — transação única: tenant_databases + tenant READY + provisioning_job RUNNING → SUCCEEDED
```

`database_name`/`role_name` não aparecem como um passo próprio: são derivados de forma pura
(sem I/O) a partir do `tenant.id`, sem nada que possa falhar parcialmente — calculados
inline no início da execução, não observados como etapa separada.

### Contrato conceitual: `ProvisioningResult`

Ao concluir os passos 1–6 com sucesso, `DatabaseProvisioner.provision()` retorna (em vez de
`void`) tudo o que a camada de aplicação precisa para a transação final — nada além disso:

```ts
interface ProvisioningResult {
  clusterId: string;
  databaseName: string;
  secretReference: string;
  schemaVersion: number;
}

interface DatabaseProvisioner {
  provision(input: { provisioningJobId: string; tenantId: string }): Promise<ProvisioningResult>;
}
```

Isso é uma mudança conceitual **futura** em relação à interface hoje existente em
`src/modules/provisioning/application/process-provisioning-job.ts`
(`provision(): Promise<void>`) — **não implementada nesta tarefa**. Quando o
`DatabaseProvisioner` real for escrito, essa é a forma que seu retorno deve assumir; o
`ProcessProvisioningJobRepository` também precisará, no futuro, de uma operação de
finalização que aceite esse resultado (por exemplo, uma versão estendida de
`markSucceeded` que também registre `tenant_databases` e ative o tenant) — o nome e a forma
exata dessa operação ficam para a tarefa de implementação, não para esta ADR.

### Por que essa ordem, e não a ordem conceitual do prompt

A ordem ingênua (gerar credencial → salvar secret → criar role → criar database) tem um
risco real, exatamente o que o prompt pede para analisar:

```text
secret salvo
    ↓
CREATE ROLE nunca roda (ou roda com outra senha)
    ↓
secret armazenado não corresponde à senha real da role
```

Esse é um estado pior que "recurso ausente": é um **recurso presente e inconsistente**, e
nenhum retry ingênuo o conserta sozinho (reconhecer que "a role já existe" não diz se a
senha salva ainda é a correta).

A ordem escolhida resolve isso invertendo a causalidade: **a role só recebe uma senha nova
quando o secret correspondente ainda não existe/não é recuperável**, e o secret só é salvo
**depois** que a senha já está de fato aplicada na role via `CREATE ROLE ... PASSWORD` ou
`ALTER ROLE ... PASSWORD`. Detalhado por caso:

- **Role não existe**: gera senha nova, `CREATE ROLE ... LOGIN PASSWORD '<senha>'`, depois
  salva no `SecretStore`.
- **Role existe e o secret existe**: nada a fazer — reconhece e segue para `CREATE_DATABASE`.
- **Role existe mas o secret não existe/não é recuperável** (exatamente o cenário de falha
  acima): seguro gerar uma **senha nova** e `ALTER ROLE ... PASSWORD '<nova senha>'` — como
  o secret nunca foi salvo com sucesso, nada externo poderia depender do valor antigo, então
  sobrescrever é seguro. Salva a nova senha em seguida.

Com isso, "secret salvo" sempre implica "a role já tem exatamente essa senha" — a
inconsistência que motivou a pergunta do prompt deixa de ser um estado alcançável.

O risco simétrico do prompt (`CREATE DATABASE` criado, mas o registro em `tenant_databases`
nunca ocorre) é tratado de forma diferente: não é um problema de **consistência de dado**
como o da senha — é só um recurso físico que existe e ainda não foi reconhecido no Control
Plane. Um retry futuro detecta "database já existe" e simplesmente pula para o próximo
passo. Ver "Partial failures" abaixo para os cenários completos.

## Idempotency

Cada recurso tem uma chave estável, derivada de `tenant.id` — nunca de valores que mudam
(slug) ou que só existem durante a execução (timestamps, IDs de tentativa):

| Recurso | Chave estável |
| --- | --- |
| Nome do database | `tenant_<uuid>` |
| Nome da role | `tenant_<uuid>_app` |
| Caminho do secret | `tenant-databases/<uuid>` |
| Unicidade de `tenant_databases` | `tenant_id` (já garantida pela constraint `UNIQUE` existente) |

Antes de criar qualquer recurso, o provisionador **descobre** o estado atual (role existe?
database existe? secret existe e é recuperável? migrations já aplicadas? `tenant_databases`
já existe?) e decide a ação a partir daí — nunca assume que a execução começa do zero. Isso
vale tanto para um retry manual futuro quanto para uma segunda tentativa do mesmo worker após
um crash.

## Partial failures

Estados parciais são esperados, não uma falha do design:

- **Role existe, database não existe**: `CREATE_ROLE`/`SAVE_CREDENTIALS` concluídos,
  `CREATE_DATABASE` não rodou ou falhou. Retry reconhece a role (ver regra de
  reconhecimento acima) e prossegue para `CREATE_DATABASE`.
- **Database existe, `tenant_databases` não existe**: todos os efeitos externos concluídos,
  mas a transação final do Control Plane nunca rodou ou falhou (ex.: crash entre o health
  check e a transação, ou a própria transação falhando). Retry verifica que role, database,
  migrations e health check já estão satisfeitos e vai direto para `REGISTER_DATABASE` —
  **nunca recria o database**.
- **Database existe, migrations incompletas**: a ferramenta de migration do Tenant Data
  Plane precisa, ela mesma, ser idempotente/resumível (mesma garantia que as migrations do
  Control Plane já têm via `drizzle.__drizzle_migrations`) — reaplicar `RUN_MIGRATIONS`
  deve continuar de onde a ferramenta de migration registrar que parou, não do zero.

## Compensation

Duas alternativas:

- **A — compensação destrutiva**: tentar apagar (`DROP DATABASE`/`DROP ROLE`) tudo que foi
  criado após uma falha.
- **B — recovery idempotente**: preservar o que foi criado e deixar o próximo retry
  reconhecer e continuar.

**Decisão: B.** Compensação destrutiva automática é, ela mesma, uma operação multi-etapas
sem transação — pode falhar pelo mesmo motivo que o provisionamento original falhou,
deixando o sistema em um terceiro estado (nem provisionado, nem limpo). Ela também destrói
evidência útil para diagnóstico de uma falha real. Preservar o recurso parcial e tornar cada
etapa idempotente (que já é exigido de qualquer forma, para o caminho de sucesso) resolve o
mesmo problema com menos superfície de falha nova.

`DROP DATABASE` **não** é executado automaticamente como rollback genérico em nenhum
cenário desta ADR. Se compensações específicas e seguras forem identificadas no futuro (por
exemplo, uma ferramenta manual de limpeza para tenants definitivamente abandonados), elas
deverão ser explícitas, deliberadas e nunca automáticas — fora do escopo desta decisão.

## Tenant migrations

Migrations do **Tenant Data Plane** são um mecanismo distinto das migrations do **Control
Plane** (schema completamente diferente, aplicadas uma vez por database de tenant, não uma
vez globalmente). Estrutura de diretório futura:

```text
drizzle/
├── control-plane/   (existente)
└── tenant/          (futuro)
```

Nenhum schema ou migration de tenant é criado nesta tarefa. `tenant_databases.schema_version`
deverá representar a versão real de migration aplicada — o mecanismo exato (contador
sequencial, hash, tag) será definido junto da implementação das migrations de tenant, não
nesta ADR. Não deve ser preenchido com um valor arbitrário/hardcoded quando implementado.

## Health check

Antes de considerar o provisionamento concluído: conectar ao database recém-criado **usando
a credencial do tenant** (não a credencial administrativa) e executar uma query mínima
(equivalente a `SELECT 1`). Isso confirma, na prática, que a role, a senha salva no
`SecretStore` e o database estão todos consistentes entre si — um efeito colateral útil da
ordem escolhida acima. Validação de `schema_version` fica para quando o mecanismo de
migrations de tenant for definido.

## Finalization

Responsabilidade da **camada de aplicação** (`processProvisioningJob`/worker), não do
`DatabaseProvisioner` — ver "Fronteira de responsabilidade" na Decisão. O worker recebe o
`ProvisioningResult` do provisionador e executa, dentro de uma única transação do Control
Plane, somente depois que os passos 1–6 (seleção de cluster até health check) já foram
confirmados com sucesso:

```sql
INSERT INTO tenant_databases (cluster_id, database_name, secret_reference, schema_version)
  VALUES (result.clusterId, result.databaseName, result.secretReference, result.schemaVersion)
UPDATE tenants SET status = 'READY' WHERE id = ?
UPDATE provisioning_jobs SET status = 'SUCCEEDED', finished_at = now()
  WHERE id = ? AND status = 'RUNNING'
```

**Sim, atômicas as três** — a mesma garantia de "nunca existe um sem o outro" já aplicada à
criação de `tenants` + `provisioning_jobs` (ver ARCHITECTURE.md). O guard `AND status =
'RUNNING'` no `UPDATE` de `provisioning_jobs` é o mesmo padrão já usado por
`markSucceeded`/`markFailed` (Prompt 009) — a escrita continua sendo a própria arbitragem,
não um `SELECT` seguido de `UPDATE`.

### Crash antes da finalização

Cenário explícito (seção 28 do prompt original):

```text
infraestrutura externa concluída (DatabaseProvisioner já retornou um ProvisioningResult)
    ↓
processo morre antes da transação final (REGISTER_DATABASE)
    ↓
provisioning_job permanece RUNNING; tenant_databases não existe; tenant permanece PROVISIONING
```

No retry (manual ou automático, quando existir):

1. `DatabaseProvisioner.provision()` roda de novo. Pelos passos 1–6 serem idempotentes por
   descoberta, ele reconhece cluster, role, secret, database, migrations e health check já
   existentes/satisfeitos — nenhum recurso externo é recriado.
2. Retorna um `ProvisioningResult` **logicamente idêntico** ao da tentativa anterior (mesmo
   `clusterId`, `databaseName`, `secretReference`, `schemaVersion` — todos deriváveis de
   forma determinística a partir do `tenant.id` e do que já está persistido).
3. A camada de aplicação tenta a transação final novamente, agora com sucesso.

Se essa transação falhar depois que toda a infraestrutura externa já está pronta, o retry
não recria nada externo — reconhece que role/database/migrations/health check já estão
satisfeitos e tenta novamente **apenas** esta transação final.

## Tenant activation

`tenants.status = READY` só é definido dentro dessa mesma transação final da camada de
aplicação, nunca antes e nunca pelo `DatabaseProvisioner`. Precondições, todas satisfeitas:
database criado, credencial criada e salva, migrations aplicadas, health check aprovado,
`tenant_databases` registrado — as cinco, não um subconjunto.
Antes disso, `tenant.status` permanece `PROVISIONING` mesmo que `provisioning_job` já esteja
`SUCCEEDED` momentaneamente dentro da mesma transação (a atualização é atômica, então esse
estado intermediário nunca é observável de fora).

## Security

- `error_message` em `provisioning_jobs` **nunca** persiste texto bruto de driver
  PostgreSQL, provider de cloud ou `SecretStore`. O `DatabaseProvisioner` real deve lançar
  erros com uma mensagem controlada por etapa, por exemplo:

  ```text
  "Failed to select database cluster"
  "Failed to create tenant credentials"
  "Failed to create tenant database"
  "Failed to run tenant migrations"
  "Failed tenant database health check"
  "Failed to register tenant database"
  ```

  Detalhe técnico completo (stack, código de erro do driver, etc.) vai somente para logging
  estruturado (Pino), nunca para a coluna. **Compatibilidade com o código já existente**: o
  `processProvisioningJob` atual (ADR-002/worker) já apenas trunca `error.message` sem
  tentar interpretar o conteúdo — nenhuma mudança é necessária nessa camada; a
  responsabilidade de nunca lançar uma mensagem sensível passa a ser inteiramente do futuro
  `DatabaseProvisioner`.
- Logging pode incluir `tenantId`, `provisioningJobId`, `clusterId`, `databaseName` e o
  step atual — nunca `password`, `DATABASE_URL`, connection string completa, o valor do
  secret ou a credencial administrativa. `databaseName` é seguro de logar porque é derivado
  do UUID técnico, não de dado de negócio.
- A credencial administrativa do cluster nunca é exposta à aplicação nem à role do tenant.

## Error handling

Erros são específicos por etapa (ver lista acima), permitindo diagnóstico sem expor detalhe
sensível. `FAILED` continua terminal nesta fase (ADR-002) — nenhuma política de retry
automático é definida aqui. A idempotência de cada etapa desta ADR é precisamente o que
tornará um futuro retry manual (ou automático, quando existir) seguro de executar: ele só
precisa rodar de novo o mesmo fluxo da camada de aplicação — `DatabaseProvisioner.provision()`
seguido da transação final — sem se preocupar em distinguir o quanto da tentativa anterior
já havia avançado (ver "Crash antes da finalização").

## Recovery

Problema já registrado no ADR-002 (Cenário E) e reafirmado aqui: um worker pode morrer no
meio da execução, deixando `provisioning_jobs.status = RUNNING` indefinidamente, sem que
nada o reconheça como abandonado.

Direção recomendada (não implementada nesta tarefa): um mecanismo de lease análogo ao do
dispatcher (ADR-002), mas **pertencente exclusivamente ao worker**, nunca confundido com
`dispatch_lease_until` (que é do dispatcher). Nomes conceituais candidatos:

```text
execution_heartbeat_at
execution_lease_until
```

O worker atualizaria esse campo periodicamente enquanto processa; um processo de
reconciliação futuro (não desenhado nesta ADR) poderia identificar jobs `RUNNING` cujo lease
de execução expirou e torná-los elegíveis para um novo attempt — que, graças à idempotência
por descoberta definida nesta ADR, poderia retomar com segurança a partir do
`current_step` registrado, sem recriar recursos já existentes. Migration futura, não
implementada agora.

## Alternatives considered

- **A — compensação destrutiva** vs. **B — recovery idempotente**: **B escolhida** (ver
  "Compensation").
- **C — criar `tenant_databases` no início** vs. **D — criar somente após recurso
  funcional**: **D escolhida** (ver "Tenant migrations"/"Provisioning steps") — até lá,
  `provisioning_jobs.current_step` é a única fonte de progresso; `tenant_databases` nunca
  representa um database parcial ou não verificado.
- **E — credencial no Control Plane** vs. **F — credencial em `SecretStore` +
  `secret_reference`**: **F escolhida**, consistente com a decisão já tomada para
  `database_clusters.secret_reference` desde o schema inicial (Prompt 002) — nenhuma
  credencial real é persistida no Control Plane, só o ponteiro.
- **Seleção de cluster A/B/C**: **C envolvendo B** escolhida (ver "Cluster selection").
- **G — `DatabaseProvisioner` persiste a finalização** vs. **H — `DatabaseProvisioner`
  retorna um resultado, a camada de aplicação persiste**: **H escolhida** (revisão desta
  ADR). G foi a formulação original, corrigida após revisão: ela faria o provisionador
  escrever em `tenants`/`provisioning_jobs`/`tenant_databases`, duplicando/contornando a
  responsabilidade que o Prompt 009 já atribuiu explicitamente à camada de aplicação
  (`processProvisioningJob`) como dona da máquina de estado. H preserva essa fronteira já
  estabelecida: o provisionador só sabe executar/descobrir infraestrutura externa.
- **Ownership do database: role do tenant** vs. **role administrativa**: **role
  administrativa escolhida** (revisão desta ADR). A formulação original ("`OWNER =
  tenant_role`") concedia à role do tenant mais controle do que a operação normal da
  aplicação exige. A role administrativa permanece dona do database e de todos os objetos
  de migration; a role do tenant recebe apenas os privilégios de aplicação necessários
  (`CONNECT`, `USAGE`, DML) via `ALTER DEFAULT PRIVILEGES` — ver "Credentials and secrets".

## Consequences

- Nenhuma migration é criada nesta tarefa. O schema atual (`tenant_databases.secret_reference`,
  `.schema_version`, `database_clusters.secret_reference`) já acomoda tudo o que esta ADR
  decide — nenhuma alteração de schema é necessária para começar a implementar
  `DatabaseProvisioner` seguindo esta decisão.
- Uma migration futura identificada, não implementada: campos de lease de execução do
  worker (`execution_heartbeat_at`/`execution_lease_until` ou equivalente) para recovery de
  `RUNNING` abandonado.
- O futuro `DatabaseProvisioner` precisa ser escrito com a ordem e as regras de
  reconhecimento de recurso existente definidas aqui — em particular, a regra de que salvar
  o secret só acontece depois que a role já reflete a senha salva.
- O step atual do worker (`PROVISION_DATABASE`, único, do Prompt 009) será refinado para os
  sete steps listados em "Provisioning steps" quando o `DatabaseProvisioner` real for
  implementado — nenhuma mudança de código acontece nesta tarefa.
- `tenants.status = READY` continua não implementado; quando implementado, só pode
  acontecer dentro da transação final atômica descrita aqui, executada pela camada de
  aplicação — nunca pelo `DatabaseProvisioner`.
- A interface `DatabaseProvisioner.provision()` precisará mudar seu retorno de `void` para
  `ProvisioningResult` quando a implementação real for escrita — mudança futura, não feita
  nesta tarefa. `ProcessProvisioningJobRepository` também precisará de uma operação de
  finalização estendida que aceite esse resultado — forma exata não decidida aqui.
- O database e todos os objetos de migration do Tenant Data Plane são de propriedade da
  credencial administrativa do cluster, não da role do tenant — decisão revisada em relação
  à formulação inicial desta ADR (ver "Alternatives considered", G/H e ownership).
- Recovery de `RUNNING` abandonado permanece uma lacuna conhecida e não resolvida — a
  direção está registrada, a implementação não.

## Prompt 011 — fundação determinística implementada

As peças sem efeito externo desta ADR (identidade de recursos, seleção de cluster, porta de
secret) foram implementadas. Dois detalhes de assinatura ficaram mais concretos do que o
esboço conceitual acima — refinamentos, não mudanças de decisão:

- **`DatabaseClusterSelector`**: a assinatura implementada é
  `selectClusterFor(tenantId: string): Promise<DatabaseCluster>`, com
  `DatabaseCluster = { id, name, provider, region, secretReference }`, em vez do esboço
  `Promise<{ clusterId: string }>`. Motivo: o `DatabaseProvisioner` (futuro) precisa de
  `provider`/`region`/`secretReference` para agir sobre o cluster escolhido — devolver
  só o `id` obrigaria uma segunda consulta imediatamente após. Nenhuma credencial
  administrativa é incluída no tipo.
- **`SecretStore`**: o valor armazenado é `TenantDatabaseSecret { username, password }`, não
  a `string` opaca do esboço original — evita que um valor solto (`password`) fique ambíguo
  sobre a qual credencial pertence. `host`/`database` continuam de fora, pois já pertencem ao
  registry (`database_clusters`/`tenant_databases`). **Superado pelo Prompt 012** — ver
  abaixo.
- Nova variável de ambiente `TENANT_DATABASE_DEFAULT_CLUSTER` (obrigatória, sem default)
  alimenta a implementação real do `DatabaseClusterSelector` — o nome default mencionado em
  "Cluster selection" acima.
- Confirmado: nenhuma migration foi necessária; nenhuma dependência nova foi adicionada.
  `SecretStore` de produção, `DatabaseProvisioner` real e as demais lacunas continuam como
  descrito em "Consequences".

## Prompt 012 — credenciais de cluster e de tenant implementadas

Refina o `SecretStore` do Prompt 011 e implementa a resolução/geração de credencial descritas
em "Credentials and secrets" acima. Sem nenhum efeito externo (nenhum `CREATE ROLE`/`ALTER
ROLE`/`CREATE DATABASE`).

- **`SecretStore` — mudança de tipagem (supera o Prompt 011)**: o valor armazenado deixou de
  ser `TenantDatabaseSecret` tipado e passou a ser `unknown`. Motivo: um provider real (AWS
  Secrets Manager, Vault, ...) devolve JSON arbitrário sem nenhuma garantia de compile-time —
  afirmar um tipo concreto no próprio `SecretStore` seria uma falsa segurança. A validação
  passou para o ponto de recuperação: `ClusterAdminCredentialResolver` (novo) valida o
  payload com Zod antes de devolver um `ClusterAdminCredential` tipado. Regra registrada
  também em `CLAUDE.md`: nunca confiar no tipo de um secret recuperado de provider externo.
- **Tipos de credencial**: `DatabaseCredential { username, password }` como shape estrutural
  único, com `ClusterAdminCredential`/`TenantDatabaseCredential` como aliases semânticos —
  não uma hierarquia de classes, já que as duas são estruturalmente idênticas hoje. Cada uma
  tem seu próprio schema Zod `.strict()` (`clusterAdminCredentialSchema`/
  `tenantDatabaseCredentialSchema`) para poderem divergir de forma independente no futuro sem
  exigir uma migração de tipo conjunta.
- **`ClusterAdminCredentialResolver`**: `resolve(secretReference)` — busca no `SecretStore`,
  valida com `clusterAdminCredentialSchema`, retorna `ClusterAdminCredential`. Dois erros:
  `ClusterAdminSecretNotFoundError` (reference sem valor) e `InvalidClusterAdminSecretError`
  (valor presente, mas falha a validação — inclui os *paths* dos campos inválidos, nunca o
  valor). `DatabaseClusterSelector` continua sem resolver credencial nenhuma — só devolve
  `DatabaseCluster` com o `secretReference` opaco, exatamente como já decidido no Prompt 011.
- **Geração de senha do tenant** (`createTenantDatabaseCredential(roleName)`): `username` é
  sempre o `roleName` determinístico (nunca aleatório); `password` é
  `randomBytes(32)` (256 bits) de `node:crypto`, codificado em `base64url` — alfabeto
  `[A-Za-z0-9_-]`, sem padding, evita problemas de escaping em bibliotecas de conexão e
  contextos de shell/env. Função pura, sem I/O — não decide sozinha se uma nova senha é
  necessária; essa decisão (role existe? secret existe?) pertence ao futuro
  `DatabaseProvisioner`, seguindo a regra já registrada em "Idempotency"/"Por que essa ordem".
  Não é chamada por nenhum fluxo ainda (nem `POST /tenants`, nem dispatcher, nem worker).
- Confirmado: nenhuma migration foi necessária; nenhuma dependência nova foi adicionada
  (`node:crypto` e Zod já disponíveis).

## Prompt 013 — `TenantRoleProvisioner` (CREATE ROLE/ALTER ROLE) implementado

Implementa apenas `CREATE_ROLE`/`SAVE_CREDENTIALS` dos "Provisioning steps" acima —
`CREATE_DATABASE`, `RUN_MIGRATIONS`, `HEALTH_CHECK` continuam não implementados, e este
componente ainda não está ligado ao `DatabaseProvisioner`/worker.

- **Quarto caso formalizado — role ausente, secret existente**: "Por que essa ordem" acima
  documentava apenas três dos quatro estados possíveis (role nova; role+secret consistentes;
  role existe/secret ausente). O quarto — **secret existe, role ausente** — não estava
  explícito e precisa ser registrado aqui: **reutilizar a senha já salva para o `CREATE
  ROLE`, nunca gerar uma senha nova sem necessidade.** Pode acontecer após um `SecretStore.put()`
  bem-sucedido seguido de uma `CREATE ROLE` que nunca chegou a rodar ou foi desfeita, ou por
  intervenção manual. Gerar uma senha nova nesse caso romperia, sem motivo, credenciais que
  algum consumidor futuro já possa ter obtido do `SecretStore`.
- **Metadata de conexão do cluster (achado de implementação, não previsto neste ADR)**:
  `DatabaseCluster` não carregava `host`/`port` — nada com que abrir uma conexão
  administrativa real. Adicionadas duas colunas a `database_clusters`
  (`host text NOT NULL`, `port integer NOT NULL DEFAULT 5432`, com
  `CHECK (port BETWEEN 1 AND 65535)`), nunca uma connection string completa. Única migration
  desta tarefa.
- **Maintenance database**: `CREATE ROLE`/`ALTER ROLE` são operações de nível de cluster, não
  de um database específico — a conexão administrativa usa `"postgres"` (convenção padrão do
  PostgreSQL) só para ter algo a que se conectar, nunca o database do tenant (que ainda não
  existe nesta fase).
- **Password em DDL, não em bind parameter**: PostgreSQL não aceita parâmetro `$1` no lugar
  do literal de `PASSWORD` em `CREATE ROLE`/`ALTER ROLE` (statements de utilidade, ao
  contrário de `SELECT`/`INSERT`/`UPDATE`/`DELETE`). A senha é embutida no texto do SQL via
  `pg.escapeLiteral`/`pg.escapeIdentifier` (utilitário de escaping já embutido no driver `pg`
  já usado pelo projeto — nenhuma dependência nova). Erros do driver nessas duas operações
  são encapsulados em `TenantRoleProvisioningError`, cuja `.message` nunca inclui o texto cru
  do driver (que, em tese, poderia ecoar um fragmento do SQL com a senha em caso de erro de
  sintaxe) — o erro original só existe em `.cause`, nunca em `.message`.
- Verificação de credencial em teste: como o database do tenant ainda não existe, os testes
  autenticam a role recém-criada contra o database `"postgres"` do próprio cluster
  administrativo. Seguro porque PostgreSQL concede `CONNECT` a `PUBLIC` em todo database por
  padrão — abrir essa conexão não concede nenhum privilégio além do que a role já teria de
  qualquer forma.
- Confirmado: nenhum `CREATE DATABASE`, nenhum `GRANT`, nenhuma migration de tenant, nenhum
  health check, nenhuma alteração no worker/máquina de estado.

## Prompt 014 — `TenantDatabaseProvisioner` (CREATE DATABASE + isolamento de CONNECT) implementado

Implementa apenas `CREATE_DATABASE` dos "Provisioning steps" acima, mais uma decisão de
segurança que a formulação original desta ADR não detalhava — `RUN_MIGRATIONS` e
`HEALTH_CHECK` continuam não implementados, e este componente ainda não está ligado ao
`DatabaseProvisioner`/worker.

- **Decisão de segurança explícita — isolamento de CONNECT é obrigatório, não opcional.**
  PostgreSQL concede `CONNECT` a `PUBLIC` em todo database por padrão — um database exclusivo
  por tenant (ADR-001) não é, por si só, isolamento no nível de conexão, já que qualquer role
  autenticada no cluster (todas são implicitamente membros de `PUBLIC`) poderia se conectar a
  qualquer database. Toda criação/reconciliação de database de tenant em cluster compartilhado
  agora inclui, obrigatoriamente:

  ```sql
  REVOKE CONNECT ON DATABASE <tenant_database> FROM PUBLIC;
  GRANT CONNECT ON DATABASE <tenant_database> TO <tenant_application_role>;
  ```

  Ambos os comandos são reaplicados em **toda** chamada de `ensureDatabase()`, mesmo com o
  database já existente — reconcilia infraestrutura provisionada parcialmente ou por fora
  deste fluxo, nunca assume que "database existe" implica "política de CONNECT correta".
- **Ordem fail-closed.** `REVOKE` sempre roda antes do `GRANT`. Uma falha entre os dois deixa o
  database temporariamente inacessível à role do tenant — preferível a deixá-lo acessível a
  `PUBLIC`. Nenhuma compensação automática reabre `PUBLIC`; um retry apenas reaplica
  `REVOKE`/`GRANT` até convergir.
- **Pré-condição: a role de aplicação do tenant precisa existir.** Este componente nunca cria a
  role por conta própria — reconhece sua ausência e lança `TenantApplicationRoleNotFoundError`
  antes de criar/reconciliar qualquer database, tanto para um database novo quanto para um já
  existente. Mantém a ordem explícita já estabelecida em "Provisioning steps":
  `CREATE_ROLE` (Prompt 013) sempre antes de `CREATE_DATABASE` (esta tarefa).
- **Ownership**: mantido como o padrão do PostgreSQL — a credencial administrativa que executa
  `CREATE DATABASE` é a dona do database (nenhuma cláusula `OWNER` é adicionada), exatamente a
  decisão já registrada em "Credentials and secrets" acima. Nenhum owner adicional é
  inventado.
- **Concorrência real — duas corridas distintas identificadas empiricamente contra
  `postgres-tenants` real**, além da ADR original só mencionar `duplicate_database` (SQLSTATE
  `42P04`):
  1. Duas `CREATE DATABASE` genuinamente concorrentes para o mesmo nome podem, dependendo do
     timing, colidir diretamente no índice único do catálogo (`pg_database_datname_index`),
     manifestando como `unique_violation` (SQLSTATE `23505`) em vez de `42P04`. Ambos os casos
     são tratados como equivalentes: "o database já existe, criado por outra chamada" — nenhum
     outro erro do driver é silenciado como se fosse duplicidade.
  2. `REVOKE`/`GRANT` concorrentes contra a mesma linha de ACL do catálogo (`pg_database`)
     podem colidir com `"tuple concurrently updated"` (SQLSTATE `XX000`, genérico e sem
     `constraint` nomeada — não seguro de reconhecer por padrão de erro).
  - **Decisão**: em vez de tentar reconhecer e tolerar cada erro de corrida individualmente
    (especialmente o segundo, sem um SQLSTATE específico e estável), `ensureDatabase()`
    serializa chamadas concorrentes para o mesmo `databaseName` com um advisory lock de sessão
    do PostgreSQL (`pg_advisory_lock(hashtext(databaseName))`, liberado explicitamente em
    `finally` e, por segurança adicional, automaticamente ao fim da sessão caso o processo
    morra antes). A tolerância a `duplicate_database`/`unique_violation` no `CREATE DATABASE`
    é mantida como defesa em profundidade, não como o mecanismo primário de convergência.
- **Maintenance database**: reafirma a mesma escolha do Prompt 013 (`"postgres"`) —
  `CREATE DATABASE`, `REVOKE`/`GRANT ON DATABASE` e o advisory lock são todos operações de
  nível de cluster/catálogo, nenhuma delas exige conectar ao database do tenant (que, no
  início da chamada, pode nem existir ainda).
- **Identificadores seguros**: `databaseName`/`roleName` só chegam a este componente via
  `buildProvisioningResourceNames(tenantId)`; `pg.escapeIdentifier` (mesmo utilitário do
  Prompt 013) faz o quoting seguro ao interpolar os dois na DDL, e uma checagem de defesa em
  profundidade (`^[a-z0-9_]+$`) recusa prosseguir se essa garantia for violada.
- Confirmado: nenhuma migration, nenhum `GRANT` de tabelas/schema, nenhum
  `ALTER DEFAULT PRIVILEGES`, nenhuma migration de tenant, nenhum health check, nenhuma
  alteração no worker/máquina de estado, nenhum registro em `tenant_databases`.

## Prompt 015 — schema inicial do Tenant Data Plane, migration runner e permissões implementados

Implementa `RUN_MIGRATIONS` dos "Provisioning steps" acima, mais o `GRANT`/
`ALTER DEFAULT PRIVILEGES` já detalhados em "Credentials and secrets" (antes só decisão, sem
código). `HEALTH_CHECK` continua não implementado, e nenhuma das duas peças desta tarefa está
ligada ao `DatabaseProvisioner`/worker.

- **`schemaVersion` — mecanismo escolhido.** `tenant_databases.schema_version` é `integer`
  (schema não alterado nesta tarefa); a representação escolhida é a contagem de linhas em
  `drizzle.__drizzle_migrations` (tabela que o próprio migrator do `drizzle-orm` cria e
  mantém — `id serial, hash text, created_at bigint`, uma linha por migration efetivamente
  aplicada). Deriva do estado real das migrations aplicadas, nunca de um contador paralelo
  mantido manualmente — exatamente a preferência já registrada nesta ADR. Cresce em
  exatamente 1 a cada nova migration de tenant adicionada e aplicada; estável entre chamadas
  quando nada novo está pendente.
- **Migration runner — comportamento do migrator do `drizzle-orm` verificado, não assumido.**
  `drizzle-orm/node-postgres`'s `migrate()` já (re)aplica apenas migrations mais novas que a
  última registrada em `drizzle.__drizzle_migrations`, dentro de uma única transação — seguro
  para chamar repetidamente, e seguro contra um crash no meio de uma migration (a transação
  nunca comita parcialmente). **Não** é, por si só, seguro contra duas chamadas concorrentes
  para o mesmo database: a leitura da última migration aplicada acontece *antes* dessa
  transação, então duas chamadas concorrentes podem ambas observar "nada aplicado ainda" e
  ambas tentarem o mesmo `CREATE TABLE` — a mesma classe de corrida real de catálogo já
  encontrada e tratada em `postgres-tenant-database-provisioner.ts` (Prompt 014).
  **Decisão**: em vez de inventar um lock distribuído novo, `runTenantMigrations()` reutiliza
  exatamente a técnica já validada no Prompt 014 — um advisory lock de sessão do PostgreSQL
  (`pg_advisory_lock(hashtext(<chave fixa>))`), com o pool limitado a `max: 1` para garantir
  que o lock, a migration e o unlock rodem sempre na mesma conexão física (necessário para
  `pg_advisory_unlock` de fato liberar o que `pg_advisory_lock` adquiriu). Como o alvo de cada
  chamada já é sempre um único database de tenant específico, a chave do lock não precisa
  incorporar o nome do database (diferente do Prompt 014, que compartilha uma única conexão
  de manutenção `"postgres"` entre todos os tenants).
- **`GRANT`/`ALTER DEFAULT PRIVILEGES` implementados, mas em ordem divergente da nota
  registrada anteriormente nesta ADR — sinalizado explicitamente, não seguido em silêncio.**
  "Future implementation notes" (abaixo) recomendava `ALTER DEFAULT PRIVILEGES` como o
  **primeiro** statement no database, **antes** de qualquer migration — nessa ordem, o
  `GRANT` explícito sobre objetos existentes seria só um mecanismo de recuperação, nunca
  necessário no caminho feliz. O Prompt 015 especificou explicitamente a ordem oposta:
  `RUN_MIGRATIONS` roda primeiro, e **todos** os `GRANT`s (incluindo
  `ALTER DEFAULT PRIVILEGES`) rodam depois — é essa ordem explícita da tarefa que foi
  implementada, não a nota anterior. Consequência real: o `GRANT` explícito sobre objetos
  existentes deixa de ser só "mecanismo de recuperação" e passa a ser sempre necessário no
  caminho feliz também, já que `ALTER DEFAULT PRIVILEGES` nunca chega a rodar antes de a
  primeira migration já ter criado `users`/`audit_logs`/`outbox_events`. Ambas as ordens são
  seguras e convergem para o mesmo resultado final (nenhuma é logicamente melhor que a
  outra) — a nota antiga na seção "Future implementation notes" está desatualizada em relação
  à implementação real e deve ser lida como superada por este registro.
  `grantTenantApplicationPrivileges()` concede `USAGE` no schema `public`, `SELECT`/
  `INSERT`/`UPDATE`/`DELETE` em todas as tabelas existentes, `USAGE`/`SELECT` em todas as
  sequences existentes, e configura `ALTER DEFAULT PRIVILEGES` para tabelas/sequences
  futuras — nessa ordem, reaplicável a qualquer momento sem erro (`GRANT` e
  `ALTER DEFAULT PRIVILEGES` são idempotentes por natureza; nenhum lock adicional foi
  necessário aqui). `FOR ROLE` é omitido deliberadamente no `ALTER DEFAULT PRIVILEGES`: o
  PostgreSQL usa a role atual da conexão quando omitido, que já é a credencial
  administrativa/de migration conectada — a mesma que rodará toda migration futura.
- **`public.CREATE` — fail-closed, não apenas confiando no default.** PostgreSQL 15+ já para
  de conceder `CREATE` em `public` para `PUBLIC` por padrão, mas esse default nunca é
  assumido: `grantTenantApplicationPrivileges()` executa
  `REVOKE CREATE ON SCHEMA public FROM PUBLIC` explicitamente antes de qualquer `GRANT`,
  garantindo a propriedade mesmo que o default de alguma instância divirja. Testado
  diretamente: a application role do tenant, após todos os `GRANT`s, ainda não consegue
  `CREATE TABLE` no schema `public`.
- **Application role sem DDL — propriedade central desta tarefa.** Nenhum `CREATE`/`ALTER`/
  `DROP`/`TRUNCATE`/`REFERENCES`/`TRIGGER` é concedido à role do tenant em nenhum momento.
  Comprovado com PostgreSQL real: a role consegue `INSERT`/`SELECT`/`UPDATE`/`DELETE` em
  `users` após os `GRANT`s, mas uma tentativa real de `CREATE TABLE` é rejeitada.
- **Migrations rodam com a credencial administrativa/de migration, nunca a da tenant
  application role**, consistente com "Execução de migrations" acima — `runTenantMigrations`
  e `grantTenantApplicationPrivileges` recebem a mesma credencial administrativa como alvo de
  conexão; a tenant application role nunca aparece como credencial de conexão em nenhuma das
  duas.
- **Isolamento A/B validado no nível de dados, não só de conexão** (o de conexão já era
  coberto pelo Prompt 014): dois tenants provisionados ponta a ponta (role + database +
  migrations + grants), cada um inserindo uma linha em `users` através da própria
  application role — a linha de um nunca aparece na consulta do outro, porque cada uma vive
  em um database PostgreSQL fisicamente separado, sem nenhuma coluna `tenant_id` envolvida.
- **Nenhuma coluna `tenant_id`** em `users`/`audit_logs`/`outbox_events` — o database físico
  já é o boundary de isolamento (ADR-001); uma coluna de discriminação reintroduziria
  exatamente o risco que a decisão original rejeitou.
- Confirmado: nenhuma migration nova de Control Plane (a única migration desta tarefa é
  `drizzle/tenant/0000_modern_deathbird.sql`), nenhuma alteração no worker/dispatcher/máquina
  de estado, nenhum registro em `tenant_databases`, nenhum tenant `READY`, nenhuma senha ou
  credencial administrativa persistida/logada.

## Future implementation notes

Registrado para a tarefa que implementar o `DatabaseProvisioner` real, sem comprometer
detalhes de implementação nesta ADR:

- `DatabaseClusterSelector`, `SecretStore` e `DatabaseProvisioner` são três portas
  separadas — a implementação concreta de cada uma pode evoluir independentemente das
  outras.
- A implementação local de `SecretStore` para desenvolvimento nunca deve ser versionada nem
  usada fora de ambiente local — deve ficar inteiramente atrás da interface `put/get/delete`
  definida aqui.
- Geração de senha via módulo `crypto` nativo do Node (nunca `Math.random()`).
- `current_step` permanece `text` livre — nenhum enum PostgreSQL é criado para os 7 valores
  listados, conforme já decidido para essa coluna (Prompt 002/007).
- **Superado pelo Prompt 015** — a implementação de migrations do Tenant Data Plane
  (`drizzle/tenant/`, `src/infrastructure/database/tenant/`) já existe como peça isolada
  (`runTenantMigrations`), mas ainda separada da implementação do `DatabaseProvisioner` em
  si; ambas precisam existir antes do passo `RUN_MIGRATIONS` funcionar de verdade dentro do
  worker.
- `DatabaseProvisioner.provision()` deve retornar `ProvisioningResult` (`clusterId`,
  `databaseName`, `secretReference`, `schemaVersion`) em vez de `void`. A camada de
  aplicação — não o provisionador — é quem grava esse resultado em `tenant_databases`,
  ativa o tenant e finaliza o `provisioning_job`.
- **Superado pelo Prompt 015** (ver seção "Prompt 015" acima para o registro completo): esta
  nota recomendava executar `ALTER DEFAULT PRIVILEGES` (ver "Credentials and secrets")
  **antes** de rodar a primeira migration do Tenant Data Plane, tornando o `GRANT` explícito
  apenas um mecanismo de recuperação. A implementação real seguiu a ordem oposta, explícita
  no Prompt 015: migrations primeiro, `GRANT`/`ALTER DEFAULT PRIVILEGES` depois — o `GRANT`
  explícito sobre objetos existentes é, portanto, sempre necessário no caminho feliz, não só
  na recuperação. Mantido aqui apenas como histórico da recomendação original.
