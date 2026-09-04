# imob

Plataforma SaaS imobiliária multi-tenant.

```text
imob/
├── backend/     API HTTP + workers (Node.js, TypeScript, Fastify, PostgreSQL)
└── frontend/    aplicação web (React, TypeScript, Vite — fundação inicializada; ainda sem
                  features de negócio)
```

## Organização do repositório

- **`backend/` e `frontend/` são aplicações independentes.** Cada uma possui seu próprio
  `package.json`, suas próprias dependências, seu próprio build e seus próprios testes.
- **Não é utilizado pnpm workspace** (nem npm/yarn workspaces). Não existe `package.json` na
  raiz do repositório.
- **Não há compartilhamento de packages** entre backend e frontend. Nenhum código é
  importado de um projeto para o outro; a integração acontece exclusivamente via HTTP.
- **O Git é único, na raiz `imob/`.** Não existem repositórios Git aninhados dentro de
  `backend/` ou `frontend/`.

Cada projeto é executado a partir do seu próprio diretório:

```bash
cd backend && pnpm install
```

A documentação técnica detalhada do backend (stack, execução local, Docker, variáveis de
ambiente, migrations, testes e arquitetura) está em
[`backend/README.md`](backend/README.md). A do frontend (stack, execução local, env, testes,
estrutura) está em [`frontend/README.md`](frontend/README.md).

## Versão do Node

O `.nvmrc` da raiz define a versão usada no repositório; `backend/.nvmrc` e
`frontend/.nvmrc` repetem o mesmo valor para que cada projeto seja utilizável de forma
autônoma. Hoje as três versões são idênticas.

## CI

O workflow [`.github/workflows/backend-ci.yml`](.github/workflows/backend-ci.yml) executa
`typecheck`, `lint`, `test` e `build` do backend em pull requests e em pushes para `main`,
somente quando há alteração em `backend/**`. O workflow
[`.github/workflows/frontend-ci.yml`](.github/workflows/frontend-ci.yml) faz o mesmo para o
frontend, somente quando há alteração em `frontend/**` — os dois são independentes, cada um
dispara apenas pelas mudanças do seu próprio projeto. Ainda não existe pipeline de deploy (CD).

## Conexão com o GitHub

O repositório ainda não possui remote configurado. Substitua `<owner>` e `<repository>`:

```bash
git remote add origin git@github.com:<owner>/<repository>.git
git branch -M main
git push -u origin main
```
