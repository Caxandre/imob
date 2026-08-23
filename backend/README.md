# Imob Backend

Backend de uma plataforma SaaS imobiliária multi-tenant.

Este é o projeto `backend/` dentro do repositório `imob`. O frontend é uma aplicação
independente em `frontend/`, com dependências e build próprios — não há workspace nem
packages compartilhados entre os dois. Ver o [README da raiz](../README.md).

**Todos os comandos deste documento devem ser executados a partir do diretório
`backend/`.**

Estado atual: baseline técnica inicial. Nenhuma funcionalidade de negócio (auth, tenants,
imóveis, leads, billing, etc.) foi implementada ainda.

## Stack

- Node.js 22 LTS + TypeScript (strict, ESM)
- Fastify
- PostgreSQL + Drizzle ORM
- Zod (validação de configuração)
- Redis + BullMQ (infraestrutura instalada; sem filas de negócio ainda)
- Pino (logging estruturado)
- OpenAPI/Swagger
- Vitest
- Docker / Docker Compose
- pnpm

## Requisitos

- Node.js `>=22.16.0` (ver `.nvmrc`)
- pnpm (via Corepack: `corepack enable`)
- Docker + Docker Compose

## Instalação

```bash
pnpm install
```

## Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste conforme necessário:

```bash
cp .env.example .env
```

| Variável                     | Descrição                                              |
| ----------------------------- | ------------------------------------------------------- |
| `NODE_ENV`                   | `development` \| `test` \| `production`                 |
| `HOST`                       | Host de bind do servidor HTTP                            |
| `PORT`                       | Porta do servidor HTTP                                   |
| `LOG_LEVEL`                  | Nível de log do Pino                                     |
| `CONTROL_PLANE_DATABASE_URL` | Connection string do banco do Control Plane               |
| `REDIS_URL`                  | Connection string do Redis                                |

A aplicação valida essas variáveis na inicialização (Zod) e falha imediatamente se algo
obrigatório estiver ausente ou inválido.

`.env` nunca é versionado.

## Docker (infraestrutura local)

```bash
docker compose up -d
```

Sobe três serviços:

- `postgres-control` — Control Plane (porta local `5434`)
- `postgres-tenants` — cluster onde databases de tenants serão provisionados no futuro (porta local `5433`)
- `redis` — para BullMQ e necessidades futuras (porta `6379`)

## Migrations (Control Plane)

O schema do Control Plane é versionado em `drizzle/control-plane/`.

```bash
pnpm db:generate   # gera uma nova migration a partir de src/.../control-plane/schema.ts
pnpm db:migrate    # aplica as migrations pendentes no Control Plane
```

Migrations **não** são aplicadas automaticamente quando a API inicia — subir a aplicação e
migrar o banco são operações independentes. Reexecutar `pnpm db:migrate` é seguro: o
Drizzle registra as migrations já aplicadas e ignora as que não estão pendentes.

## Execução local

```bash
pnpm dev
```

Servidor sobe em `http://localhost:3000` (ajustável via `PORT`).

- Health check: `GET /health`
- Documentação OpenAPI: `GET /docs`

## Build e produção

```bash
pnpm build
pnpm start
```

## Comandos disponíveis

| Comando           | Descrição                                  |
| ------------------ | -------------------------------------------- |
| `pnpm dev`         | Sobe a API em modo desenvolvimento (watch)   |
| `pnpm db:generate` | Gera migration a partir do schema do Control Plane |
| `pnpm db:migrate`  | Aplica migrations pendentes do Control Plane |
| `pnpm build`       | Compila TypeScript para `dist/`              |
| `pnpm start`       | Executa o build de produção                  |
| `pnpm typecheck`   | Verifica tipos sem gerar output              |
| `pnpm lint`        | Executa o ESLint                             |
| `pnpm format`      | Formata o código com Prettier                |
| `pnpm test`        | Executa a suíte de testes (Vitest)           |

## Testes

```bash
docker compose up -d postgres-control   # pré-requisito dos testes de persistência
pnpm test
```

- Os testes de integração HTTP usam `Fastify.inject()` — nenhuma porta de rede real é aberta.
- Os testes de persistência do Control Plane **exigem o serviço `postgres-control` no ar**.
  Eles nunca usam o banco de desenvolvimento: antes da suíte rodar, `test/global-setup.ts`
  recria do zero um banco dedicado (`imob_control_test`, no mesmo servidor) e aplica todas
  as migrations nele. Assim cada execução também valida o caminho
  "banco vazio → migrations → schema completo".

Para apontar os testes a outro servidor PostgreSQL, defina
`CONTROL_PLANE_TEST_DATABASE_URL`.

## Architecture

Documentação completa em [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)
e decisões em [`docs/architecture/adr/`](docs/architecture/adr/).

Resumo:

- **Backend e frontend são aplicações independentes**, sem workspace e sem packages
  compartilhados, versionadas no mesmo repositório Git.
- **Monólito modular**: API HTTP e workers vivem no mesmo projeto, com entrypoints
  independentes (apenas a API está implementada nesta fase).
- **Control Plane**: banco PostgreSQL central com dados globais do SaaS (tenants, planos,
  billing, provisioning) — ainda sem tabelas implementadas.
- **Tenant Data Plane**: cada tenant terá seu próprio database PostgreSQL exclusivo — a
  criação dinâmica desses databases é trabalho futuro, fora do escopo desta fase.
- O código de domínio nunca assume que todos os tenants compartilham o mesmo database.
