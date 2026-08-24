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

**Privilégios**: a role do tenant nunca recebe `SUPERUSER` nem qualquer privilégio
administrativo de cluster. `CREATE DATABASE ... OWNER = tenant_role` faz a role dona apenas
do seu próprio database — controle total dentro dele, nenhum privilégio fora dele. Como a
role de um tenant só se conecta ao seu próprio database, "ser dona" do seu database não é
uma escalação de privilégio em relação a outros tenants.

**Ownership / execução de migrations**: preferência confirmada pela análise —
o **admin do cluster** executa provisioning e migrations do tenant (evita ter que gerenciar
uma segunda role de migration por tenant); a **role do tenant** só tem os privilégios de
aplicação sobre seu próprio database. Não criar uma role adicional de "migration/admin" por
tenant nesta fase — complexidade desnecessária para a primeira versão.

## Provisioning steps

Sequência final (revista a partir do rascunho conceitual do prompt — ver justificativa na
próxima seção):

```text
1. SELECT_CLUSTER      — DatabaseClusterSelector.selectClusterFor(tenantId)
2. CREATE_ROLE         — cria ou reconhece a role tenant_<uuid>_app
3. SAVE_CREDENTIALS    — persiste a senha no SecretStore (somente após a role já refletir essa senha)
4. CREATE_DATABASE     — cria (ou reconhece) o database, OWNER = tenant role
5. RUN_MIGRATIONS      — aplica as migrations do Tenant Data Plane
6. HEALTH_CHECK        — conecta com a credencial do tenant, executa uma query mínima
7. REGISTER_DATABASE   — transação única do Control Plane: tenant_databases + tenant READY + provisioning_job SUCCEEDED
```

`database_name`/`role_name` não aparecem como um passo próprio: são derivados de forma pura
(sem I/O) a partir do `tenant.id`, sem nada que possa falhar parcialmente — calculados
inline no início da execução, não observados como etapa separada.

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

Dentro de uma única transação do Control Plane, executada somente após os passos 1–6 (seleção
de cluster até health check) terem sido confirmados com sucesso:

```sql
INSERT INTO tenant_databases (...)   -- database_name, cluster_id, secret_reference, schema_version
UPDATE tenants SET status = 'READY' WHERE id = ?
UPDATE provisioning_jobs SET status = 'SUCCEEDED', finished_at = now() WHERE id = ?
```

**Sim, atômicas as três** — a mesma garantia de "nunca existe um sem o outro" já aplicada à
criação de `tenants` + `provisioning_jobs` (ver ARCHITECTURE.md). Se essa transação falhar
depois que toda a infraestrutura externa já está pronta (cenário do prompt, seção 28), o
retry não recria nada externo — reconhece que role/database/migrations/health check já
estão satisfeitos e tenta novamente **apenas** esta transação final.

## Tenant activation

`tenants.status = READY` só é definido dentro dessa mesma transação final, nunca antes.
Precondições, todas satisfeitas: database criado, credencial criada e salva, migrations
aplicadas, health check aprovado, `tenant_databases` registrado — as cinco, não um subconjunto.
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
precisa rodar o mesmo `DatabaseProvisioner.provision()` de novo.

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
  acontecer dentro da transação final atômica descrita aqui.
- Recovery de `RUNNING` abandonado permanece uma lacuna conhecida e não resolvida — a
  direção está registrada, a implementação não.

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
- A implementação de migrations do Tenant Data Plane (`drizzle/tenant/`) é uma tarefa
  própria, separada da implementação do `DatabaseProvisioner` em si, mas ambas precisam
  existir antes do passo `RUN_MIGRATIONS` funcionar de verdade.
