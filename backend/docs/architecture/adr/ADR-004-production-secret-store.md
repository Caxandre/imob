# ADR-004: Production Secret Store

## Status

Aceito. Implementação: **PLANNED** (nenhum código de produção existe ainda).

## Contexto

`SecretStore` (`src/modules/provisioning/application/secret-store.ts`, ADR-003) já define a
porta que todo código de provisionamento e, a partir do Prompt 020, todo runtime de negócio de
tenant usa para resolver credenciais de database (`secretReference` → `{username, password}`),
sem nunca persistir a credencial real no Control Plane. A única implementação existente,
`createInMemorySecretStore`, é explicitamente test/dev support: guarda os secrets em um `Map`
em memória, sem durabilidade, sem criptografia, sem isolamento entre processos, e recusa-se a
construir sob `NODE_ENV=production`.

Isso deixa um lacuna deliberadamente não resolvida até agora: nenhuma ADR registrava qual
provider real de secrets a plataforma pretende usar em produção. `provisioning-worker.ts`
(Prompt 018/019) e o runtime tenant database connection manager (Prompt 020) ambos recusam-se
a iniciar/operar em produção justamente por causa dessa lacuna — refletindo uma decisão real já
tomada na prática (não fingir prontidão que não existe), só que nunca formalizada em ADR.

## Decisão

**Provider alvo de produção: AWS Secrets Manager.**

**Status atual: PLANNED — nenhuma implementação existe.** `createInMemorySecretStore`
continua sendo a única implementação, reservada a `development`/`test`. Nenhum SDK da AWS
(`@aws-sdk/client-secrets-manager` ou equivalente) é adicionado como dependência nesta ADR —
essa é uma decisão de arquitetura, não a implementação em si.

### Racional

- **Deployment futuro na AWS.** A escolha de provider segue a infraestrutura de nuvem alvo já
  presumida para o deploy de produção da plataforma — evita introduzir um segundo provider de
  nuvem só para secrets.
- **Secrets fora do Control Plane.** Mantém a garantia já estabelecida em ADR-003/CLAUDE.md de
  que nenhuma credencial real (senha, connection string completa) é persistida no PostgreSQL do
  Control Plane — `secret_reference` continua sendo somente um ponteiro.
- **IAM granular.** AWS Secrets Manager permite políticas IAM por secret/prefixo, possibilitando
  no futuro restringir exatamente quais componentes (worker de provisionamento, runtime de
  tenant, etc.) podem ler quais secrets — mais granular do que um `SecretStore` em memória ou um
  arquivo de configuração jamais poderiam oferecer.
- **Rotação futura.** `TenantDatabaseConnectionManager.invalidate()` (Prompt 020) já existe
  precisamente para dar a uma futura rotação de credencial um ponto de invalidação de pool —
  AWS Secrets Manager tem suporte nativo a rotação automática de secrets, o que este ADR
  simplesmente aponta como o caminho natural quando a rotação for implementada (não é
  implementada agora).
- **Auditabilidade.** AWS Secrets Manager integra nativamente com CloudTrail, dando um
  histórico de acesso a secrets que uma implementação própria precisaria reconstruir do zero.

## Consequências

- `SecretStore` (a porta) permanece inalterada — ela já foi desenhada em ADR-003
  especificamente para não assumir nenhuma tipagem que um provider real não possa garantir
  (`put`/`get`/`delete` sobre `unknown`, validação Zod no ponto de uso). Uma implementação real
  de AWS Secrets Manager é só mais um adapter atrás dessa mesma porta.
- Nenhuma dependência da AWS é adicionada até que a implementação real seja de fato construída.
- `createInMemorySecretStore` continua sendo a única implementação disponível, e continua
  recusando-se a construir sob `NODE_ENV=production` — essa proteção não é enfraquecida por
  esta ADR.
- Todo entrypoint de produção que depende de `SecretStore` (o worker de provisionamento hoje;
  o runtime tenant database connection manager a partir do Prompt 020, quando algum consumidor
  HTTP existir) continua recusando-se a iniciar/operar em `NODE_ENV=production` até que esta
  ADR seja implementada.

## Alternativas consideradas

- **HashiCorp Vault**: viável tecnicamente, mas exigiria operar infraestrutura própria adicional
  (ou um serviço gerenciado à parte) sem vantagem concreta sobre um provider gerenciado nativo
  da nuvem alvo — rejeitada por complexidade operacional desproporcional para esta fase.
- **Variáveis de ambiente/arquivo de configuração criptografado**: rejeitada por não oferecer
  rotação, IAM granular ou auditabilidade — reintroduziria, na prática, o mesmo tipo de risco
  que `SecretStore` foi desenhado para evitar.
