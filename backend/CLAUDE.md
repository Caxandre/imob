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
