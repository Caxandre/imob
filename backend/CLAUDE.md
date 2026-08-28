# CLAUDE.md

Contrato operacional para execução de tarefas neste repositório (backend da plataforma SaaS
imobiliária). Leia isto antes de implementar qualquer coisa.

## Antes de implementar

- Leia este `CLAUDE.md` por completo.
- Leia a documentação arquitetural relacionada em `docs/architecture/` (especialmente
  `ARCHITECTURE.md` e os ADRs em `docs/architecture/adr/`).
- Inspecione o código atual — não assuma estrutura a partir de memória ou de execuções
  anteriores.
- Verifique o estado do Git (`git status`, `git log`) antes de alterar qualquer coisa.
- Não suponha que a documentação representa necessariamente o estado atual do código. Em caso
  de divergência entre documentação e código, o código é a fonte da verdade — sinalize a
  divergência em vez de silenciosamente confiar na documentação.

## Durante a implementação

- Respeite o escopo da tarefa pedida. Não implemente funcionalidades adicionais só porque
  aparecem em documentação arquitetural ou parecem um próximo passo óbvio.
- Não faça refatorações não relacionadas à tarefa atual.
- Não altere decisões arquiteturais (ver ADRs) sem autorização explícita.
- Não introduza dependências novas sem necessidade concreta. Antes de adicionar uma
  dependência, verifique se Node.js ou as bibliotecas já presentes resolvem o problema.
- Preserve compatibilidade com as decisões registradas em `docs/architecture/adr/`.
- Prefira mudanças pequenas e verificáveis a mudanças grandes e difíceis de revisar.
- Evite abstrações sem consumidor concreto (generic repositories, base classes genéricas,
  factories sem necessidade, interfaces criadas só por formalidade).
- TypeScript em modo strict. Evite `any` e casts que escondem problemas de tipo — se um cast
  for realmente necessário, justifique com um comentário curto explicando o porquê.
- Logging estruturado via Pino. Nunca `console.log` como mecanismo normal de logging. Nunca
  logar senhas, tokens, connection strings completas, secrets ou dados pessoais
  desnecessários.
- Nunca manter uma transação PostgreSQL aberta durante uma operação externa (Redis, BullMQ,
  HTTP, filesystem, Secrets Manager). Transações devem conter somente operações PostgreSQL
  necessárias; ver ADR-002 para o raciocínio completo aplicado ao dispatcher de
  provisionamento.
- Registros de domínio com valor de negócio/histórico não devem ser excluídos fisicamente por
  padrão; prefira um estado de ciclo de vida explícito (ex.: `status = INACTIVE`) a menos que
  uma funcionalidade concreta exija exclusão real. Ver `properties` (Prompt 022) como exemplo
  aplicado: `DELETE /api/v1/properties/:id` nunca executa `DELETE FROM properties`.
- Mídia binária nunca deve ser persistida no PostgreSQL; grave objetos através de
  `ObjectStorage` (ADR-006) e mantenha apenas metadados/referências (ex.: key, URL pública) nas
  tabelas do Tenant Data Plane.
- Tipos de SDK de provider externo (Cloudflare/AWS, `@aws-sdk/client-s3` incluído) nunca devem
  vazar para portas de domínio/aplicação — confine-os inteiramente ao adapter de
  infraestrutura correspondente (ver `src/infrastructure/object-storage/` como exemplo
  aplicado).
- Object storage externo e escritas no database do tenant não compartilham transação (não há
  transação distribuída entre PostgreSQL e Cloudflare R2/S3). Todo fluxo que grava nos dois
  precisa definir explicitamente a ordem das operações e o comportamento de compensação em
  falha parcial — ver `uploadPropertyMedia` (Prompt 027, ADR-007) como exemplo aplicado: upload
  no object storage primeiro, insert no banco depois, delete compensatório best-effort se o
  insert falhar (nunca o inverso — nunca persistir metadata antes do objeto existir de fato).
- Excluir mídia é a ordem oposta do upload, deliberadamente: remova a metadata no Tenant Data
  Plane primeiro (dentro de uma transação com lock de linha na propriedade), só então tente
  remover o objeto real no object storage, como operação best-effort — nunca o inverso. Uma
  falha no delete do objeto após o commit da metadata nunca deve falhar a requisição HTTP (nunca
  503/500 só por isso); registre a falha via log estruturado (chave/mediaId, nunca segredos) e
  trate como órfão para reconciliação futura — ver `deletePropertyMedia` (Prompt 028, ADR-007
  "Delete") como exemplo aplicado. Um objeto órfão no object storage é sempre preferível a uma
  metadata persistida apontando para um objeto ausente.
- Object keys de mídia devem ser gerados no servidor a partir de IDs técnicos (UUIDs), nunca a
  partir de filename/título/endereço/nome de cliente/email fornecidos pelo usuário — ver
  `buildPropertyMediaObjectKey` (Prompt 027) como exemplo aplicado.
- Derivação de imagem (resize, geração de variantes) nunca deve executar de forma síncrona
  dentro de uma requisição HTTP normal de upload; transformações de mídia rodam de forma
  assíncrona, a partir do original preservado — ver
  [ADR-008](docs/architecture/adr/ADR-008-asynchronous-property-image-processing.md) (Prompt
  029, arquitetura definida, ainda não implementada).

## Multi-tenancy — regra crítica

- Database PostgreSQL **exclusivo por tenant**. Nunca substituir por tabelas compartilhadas
  com uma coluna `tenant_id`.
- **Control Plane** (dados globais do SaaS) é sempre separado do **Tenant Data Plane** (dados
  de cada tenant).
- Código de domínio nunca escolhe a conexão física do banco diretamente. A resolução de qual
  database usar é responsabilidade de uma camada de infraestrutura futura (Tenant Registry →
  Database Resolver → Connection Manager), estabelecida a partir do contexto autenticado da
  requisição.
- Nunca confiar em um database, schema ou connection string informado diretamente pelo
  cliente (parâmetros como `databaseName`, `databaseUrl`, `connectionString` vindos de
  request nunca devem determinar a conexão usada).
- Tenants podem estar distribuídos em múltiplos clusters PostgreSQL, e alguns tenants podem
  ter infraestrutura dedicada. Não assuma que todos os tenants estão no mesmo servidor ou
  cluster.
- Tabelas de domínio no Tenant Data Plane nunca devem conter `tenant_id` — o isolamento do
  tenant é dado pelo boundary do database, não por uma coluna discriminadora.
- Migrations de tenant nunca devem rodar como parte de uma requisição HTTP normal.

## Provisionamento de database de tenant — regras permanentes

Ver ADR-003 para o raciocínio completo.

- Nunca derivar o nome físico do database (ou da role) do `tenant.slug` — é comercial e
  pode mudar. Derivar sempre do `tenant.id`.
- Nunca persistir ou logar uma credencial real (senha, connection string completa,
  `DATABASE_URL`). `secret_reference` é sempre um ponteiro para um `SecretStore`, nunca o
  valor.
- Todo provisionamento de recurso externo (database, role, secret) deve ser idempotente por
  descoberta: verificar se o recurso já existe antes de criá-lo, nunca assumir execução do
  zero.
- Evitar compensação destrutiva automática (`DROP DATABASE`/`DROP ROLE`) em falha parcial de
  provisionamento. Preferir preservar o recurso e deixar o retry idempotente reconhecê-lo.
- `DatabaseProvisioner` nunca escreve em `tenants`, `provisioning_jobs` ou
  `tenant_databases` — ele só executa/descobre infraestrutura externa e retorna um
  resultado. Persistir esse resultado no Control Plane (e ativar o tenant) é sempre
  responsabilidade da camada de aplicação, dona da máquina de estado desde o Prompt 009.
- A role de aplicação do tenant nunca é dona (`OWNER`) do seu próprio database nem de
  objetos de migration — só recebe os privilégios operacionais mínimos (`CONNECT`,
  `USAGE`, DML). O database e seus objetos pertencem à credencial administrativa do
  cluster.
- Todo database de tenant em cluster compartilhado deve revogar `CONNECT` de `PUBLIC` e
  concedê-lo apenas às roles explicitamente autorizadas.
- Tenant application roles não executam migrations nem possuem privilégios DDL
  (`CREATE`/`ALTER`/`DROP`/`TRUNCATE`); migrations pertencem à infraestrutura administrativa
  da plataforma.
- Tenant `READY`, `tenant_databases` `READY` e provisioning job `SUCCEEDED` devem ser
  confirmados atomicamente na mesma transação do Control Plane — nunca um sem o outro.
- Uma falha ao persistir essa transação final, depois que o provisionamento externo já teve
  sucesso, nunca deve marcar o provisioning job `FAILED` — isso tornaria um database de
  tenant já funcional inalcançável por qualquer retry. Deixe o job no estado anterior
  (recuperável) e propague o erro.
- Nunca confiar no tipo de um secret recuperado de provider externo; validar o payload
  (Zod) antes de utilizá-lo. `SecretStore` é um boundary não confiável por definição — ele
  não afirma nenhuma tipagem que um provider real (AWS Secrets Manager, Vault, ...) não
  possa garantir.
- Dispatch lease e execution lease são mecanismos independentes e não podem compartilhar
  estado.
- Toda mutação terminal de provisioning `RUNNING` deve ser protegida pelo execution token
  atual.
- Runtime de negócio de tenant nunca utiliza credencial administrativa do cluster.
- Tenant Data Plane deve ser resolvido através de `tenant_databases`; não derivar database
  runtime diretamente de `slug` ou `tenantId`.

## Git, Pull Requests e CI

A partir desta tarefa, esta política é permanente para todo trabalho funcional.

> Um prompt funcional corresponde a uma branch e a um Pull Request.
>
> Nenhum novo PR funcional deve ser iniciado antes do PR anterior deste fluxo estar
> aprovado e mergeado na `main`.

Nunca trabalhar diretamente na `main`. Nunca manter dois PRs funcionais deste fluxo abertos
simultaneamente sem autorização explícita.

Fluxo:

```text
main → branch da tarefa → implementação → validação local (finalização, abaixo) → commit
→ push → PR automático → CI → aprovação humana → merge → main atualizada → próxima tarefa
```

Antes de criar a branch de uma nova tarefa: confirmar `git status` limpo, branch atual =
`main`, `git pull --ff-only` aplicado, e `gh pr list --state open` sem PR funcional pendente
deste fluxo. Se houver PR pendente, não iniciar a tarefa — reportar e aguardar.

O PR é criado via `gh pr create` ao final da implementação, não pelo usuário. O CI deve
ficar verde na mesma branch antes de qualquer pedido de aprovação. O merge só ocorre após
aprovação humana explícita — nunca auto-aprovado.

## Finalização

Antes de considerar qualquer tarefa concluída, execute, nesta ordem:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Se qualquer um desses comandos falhar, a tarefa **não está concluída**. Não relate sucesso
sem ter executado e confirmado os quatro comandos.
