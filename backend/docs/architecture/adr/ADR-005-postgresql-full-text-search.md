# ADR-005: PostgreSQL Full Text Search Before External Search Infrastructure

## Status

Aceito. Implementação: **IMPLEMENTED** (Prompt 025) — `GET /api/v1/properties?q=`.

## Contexto

O Prompt 025 pediu busca textual (`q`) sobre `title`/`description`/`street`/`neighborhood`/
`city` em `GET /api/v1/properties`. Duas famílias de abordagem existem para isso:

1. **PostgreSQL Full Text Search** (`tsvector`/`tsquery`, `to_tsvector`/`websearch_to_tsquery`,
   índice `GIN`) — nativo do banco que já hospeda cada Tenant Data Plane, sem infraestrutura
   adicional.
2. **Um motor de busca externo dedicado** (Elasticsearch, OpenSearch, Meilisearch, Algolia, ...)
   — exigiria replicar dados de `properties` para um índice separado (via CDC, outbox pattern —
   ainda **PLANNED**, nunca implementado nesta base — ou sincronização síncrona no próprio
   request), operar/hospedar um serviço adicional por ambiente, e (dado ADR-001) decidir se esse
   índice é compartilhado entre tenants ou também isolado por tenant.

Nenhum dado real de volume, padrão de consulta ou requisito de relevância desta plataforma
existe ainda — é um SaaS em fase inicial, sem tenants em produção.

## Decisão

**PostgreSQL Full Text Search, dentro do próprio Tenant Data Plane de cada tenant — nenhum
motor de busca externo.**

`properties.search_vector` (`tsvector`, `GENERATED ALWAYS AS (...) STORED`) + índice `GIN`,
consultado via `search_vector @@ websearch_to_tsquery('portuguese', $1)`, ranqueado via
`ts_rank(...)`. Ver a seção "Properties full-text search" em `ARCHITECTURE.md` para o desenho
completo.

### Racional

- **Sem infraestrutura nova.** Cada tenant já tem seu próprio database PostgreSQL (ADR-001) —
  FTS nativo reaproveita exatamente esse boundary de isolamento sem precisar decidir "o índice
  de busca é por tenant ou compartilhado" como um motor externo exigiria.
- **Sem problema de consistência a resolver.** Um `tsvector` `GENERATED ALWAYS AS ... STORED` é
  recalculado pela própria transação que grava a linha — nunca há uma janela de
  desatualização entre o dado e o índice de busca, ao contrário de qualquer pipeline de
  sincronização para um motor externo (que precisaria de outbox/CDC, hoje **PLANNED**, não
  implementado).
- **Suficiente para os requisitos reais desta fase.** Relevância simples com `setweight()`,
  suporte a português (stemming, verificado empiricamente), input natural via
  `websearch_to_tsquery` — cobre o que o Prompt 025 pediu sem construir capacidade que nada
  ainda demanda.
- **Sem dependência nova, sem custo operacional novo.** Nenhum serviço adicional para deployar,
  monitorar ou dar suporte multi-tenant; nenhuma dependência npm nova.

## Consequências

- Busca textual está limitada ao que PostgreSQL FTS oferece nativamente: sem tolerância a erros
  de digitação (typo tolerance), sem faceting nativo sofisticado, sem observabilidade de busca
  dedicada (query analytics, click-through, etc.).
- Sem normalização de acentos por padrão (`unaccent` deliberadamente não adicionado — ver
  seção "Limitações conhecidas" em `ARCHITECTURE.md`) — `q=panoramica` não encontra "panorâmica"
  hoje.
- Uma migração futura para um motor externo, se algum dia necessária, precisaria primeiro
  resolver replicação de dados por tenant (provavelmente via o outbox pattern já **PLANNED**)
  antes de sequer começar — este ADR não resolve esse problema antecipadamente, porque nenhum
  gatilho real para precisar dele existe ainda.

## Gatilhos futuros para reconsiderar (sinais reais, não números arbitrários)

- Volume de dados por tenant ou volume de tráfego de busca que degrade a latência de `GIN` de
  forma mensurável (não uma previsão — uma observação real de produção).
- Necessidade real de ranking sofisticado que `ts_rank`/`setweight()` não conseguem expressar
  (ex.: sinais de negócio combinados, personalização por usuário).
- Faceting pesado (contagens agregadas por múltiplas dimensões simultâneas em tempo real) além
  do que filtros estruturados + `count(*)` já cobrem.
- Necessidade real de typo tolerance avançada (busca aproximada/fuzzy) que o dicionário do
  PostgreSQL não oferece.
- Suporte multi-idioma complexo além de `'portuguese'` — um novo mercado/idioma que o dicionário
  PostgreSQL correspondente não cubra adequadamente.
- Necessidade de observabilidade de busca dedicada (analytics de query, relevância medida por
  clique) que não se encaixa no modelo relacional.

## Alternativas consideradas

- **Elasticsearch/OpenSearch desde já**: rejeitada — infraestrutura, operação e um pipeline de
  sincronização de dados (ainda inexistente nesta base) para um requisito que hoje é
  integralmente atendido por FTS nativo. Reavaliar apenas se um dos gatilhos acima se tornar
  real.
- **`ILIKE '%...%'` como mecanismo principal**: rejeitada explicitamente pelo Prompt 025 — sem
  ranking, sem suporte a stemming/idioma, e tipicamente sem uso eficiente de índice para padrões
  com `%` à esquerda.
- **`unaccent` desde já**: avaliada e adiada deliberadamente — não fazia parte do escopo pedido,
  e adicionar uma extensão PostgreSQL é uma decisão que merece ser tomada explicitamente, não
  como efeito colateral de uma tarefa de busca textual básica.
