# ADR-001: Database PostgreSQL exclusivo por tenant

## Status

Aceito.

## Contexto

Estamos construindo uma plataforma SaaS imobiliária multi-tenant. Precisamos decidir como
isolar os dados de cada tenant (imobiliária/cliente) uns dos outros, considerando:

- Requisitos de isolamento de dados entre tenants (segurança, privacidade, risco de
  vazamento entre clientes).
- Possibilidade de tenants com requisitos regulatórios ou contratuais que exijam
  isolamento físico mais forte.
- Necessidade futura de escalar tenants individualmente (backup, restore, migração,
  performance) sem afetar os demais.
- Possibilidade futura de oferecer infraestrutura dedicada para determinados clientes
  (planos enterprise).
- Simplicidade operacional na fase inicial do produto.

## Alternativas consideradas

### 1. Tabelas compartilhadas + coluna `tenant_id`

Todos os tenants compartilham o mesmo schema e as mesmas tabelas; cada linha carrega uma
coluna `tenant_id` usada para filtrar os dados.

- **Prós**: mais simples de operar no início (um único banco); migrations únicas; menor
  custo de infraestrutura inicial.
- **Contras**: isolamento depende inteiramente de disciplina de aplicação (toda query
  precisa filtrar por `tenant_id` corretamente); um bug de filtro vaza dados entre tenants;
  backup/restore/migração por tenant são difíceis; não permite infraestrutura dedicada por
  cliente sem reescrever a arquitetura.

### 2. Schema per tenant

Um único database PostgreSQL, com um schema separado por tenant.

- **Prós**: isolamento lógico melhor que `tenant_id` compartilhado; ainda um único
  database para operar.
- **Contras**: PostgreSQL não escala bem para milhares de schemas no mesmo database
  (overhead de catálogo, connection pooling complicado); ainda compartilha o mesmo
  processo/recursos de banco entre todos os tenants; não permite infraestrutura dedicada
  por tenant.

### 3. Database per tenant

Cada tenant possui seu próprio database PostgreSQL, podendo estar em clusters
compartilhados ou, quando necessário, em clusters dedicados.

- **Prós**: isolamento forte por padrão (impossível uma query vazar dados entre tenants
  sem uma falha explícita de infraestrutura, não de filtro); backup/restore/migração por
  tenant são naturais; permite mover um tenant para infraestrutura dedicada sem mudar a
  arquitetura da aplicação; caminho natural para compliance/enterprise.
- **Contras**: mais complexidade operacional (provisioning, migrations aplicadas por
  database, connection management); mais conexões de banco a gerenciar; custo de
  infraestrutura por tenant maior que schema/tabela compartilhada.

### 4. Instance per tenant

Cada tenant possui sua própria instância de PostgreSQL (processo/servidor dedicado).

- **Prós**: isolamento máximo, incluindo isolamento de recursos (CPU/memória/IO).
- **Contras**: custo operacional e financeiro proibitivo para a maioria dos tenants na
  fase inicial do produto; complexidade de provisioning muito maior; overkill para o
  perfil de cliente esperado inicialmente.

## Decisão

Adotar **database PostgreSQL exclusivo por tenant** (alternativa 3).

- Tenants compartilham clusters PostgreSQL por padrão.
- Determinados tenants poderão, no futuro, ser movidos para clusters PostgreSQL dedicados,
  sem exigir mudança na arquitetura da aplicação — apenas no mapeamento de qual
  cluster/conexão atende aquele tenant (Tenant Registry, futuro).
- O Control Plane (dados globais do SaaS) permanece em um database separado dos databases
  de tenant.
- O código de domínio nunca escolhe a conexão física diretamente; a resolução de qual
  database usar é responsabilidade de uma camada de infraestrutura futura (Tenant
  Registry → Database Resolver → Connection Manager), a partir do contexto autenticado da
  requisição — nunca a partir de parâmetros informados livremente pelo cliente.

## Benefícios

- Isolamento de dados forte por padrão, reduzindo drasticamente o risco de vazamento entre
  tenants por bug de aplicação.
- Backup, restore e migração granulares por tenant.
- Caminho natural de evolução para infraestrutura dedicada em planos enterprise, sem
  reescrever a arquitetura.
- Falhas de infraestrutura (ex.: um database corrompido) ficam contidas a um único tenant.

## Custos

- Maior complexidade operacional: provisioning de databases, aplicação de migrations por
  tenant, gestão de um número maior de conexões/pools.
- Maior custo de infraestrutura por tenant comparado a tabelas compartilhadas.
- Exige construir (no futuro) um Tenant Registry, um Database Resolver e um Connection
  Manager — nenhum implementado nesta fase.

## Consequências

- Toda funcionalidade de negócio que acessar dados de tenant precisará passar pela camada
  de resolução de conexão (futura) — nunca deve conectar diretamente a um database
  informado por parâmetro de requisição.
- Migrations de schema de tenant precisarão ser aplicadas a múltiplos databases (mecanismo
  ainda não implementado).
- A infraestrutura local de desenvolvimento já reflete essa decisão: `postgres-control`
  (Control Plane) e `postgres-tenants` (cluster onde databases de tenant serão
  provisionados) são serviços Docker Compose separados desde o início.

## Alternativas rejeitadas

- Tabelas compartilhadas + `tenant_id`: rejeitada por isolamento insuficiente para dados
  sensíveis de clientes de diferentes imobiliárias.
- Schema per tenant: rejeitada por não escalar operacionalmente para um número grande de
  tenants e por ainda compartilhar o mesmo processo de banco.
- Instance per tenant: rejeitada por custo e complexidade de provisioning
  desproporcionais para a fase inicial do produto.
