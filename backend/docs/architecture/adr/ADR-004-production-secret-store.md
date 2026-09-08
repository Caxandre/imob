# ADR-004: Production Secret Store

## Status

Aceito. Implementação de produção: **PLANNED** (nenhum código de produção existe ainda).

**Atualizado no Prompt 039**: um provider *somente de desenvolvimento*, persistente,
`LocalFileSecretStore`, foi implementado — ver "Atualização (Prompt 039)" abaixo. Isso não muda
o status desta ADR: continua **PLANNED** para produção.

## Contexto

`SecretStore` (`src/modules/provisioning/application/secret-store.ts`, ADR-003) já define a
porta que todo código de provisionamento e, a partir do Prompt 020, todo runtime de negócio de
tenant usa para resolver credenciais de database (`secretReference` → `{username, password}`),
sem nunca persistir a credencial real no Control Plane. Até o Prompt 039, a única implementação
existente, `createInMemorySecretStore`, era explicitamente test/dev support: guarda os secrets
em um `Map` em memória, sem durabilidade, sem criptografia, sem isolamento entre processos, e
recusa-se a construir sob `NODE_ENV=production`. O Prompt 039 acrescentou uma segunda
implementação de desenvolvimento, `LocalFileSecretStore` (persistente, em arquivo JSON local) —
ver "Atualização (Prompt 039)" abaixo. Nenhuma das duas é, ou pretende ser, um provider de
produção.

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
  de AWS Secrets Manager é só mais um adapter atrás dessa mesma porta — o mesmo vale para
  `LocalFileSecretStore` (Prompt 039), que já é só mais um adapter dev-only atrás dela.
- Nenhuma dependência da AWS é adicionada até que a implementação real seja de fato construída.
- Nenhuma das implementações de desenvolvimento (`InMemorySecretStore`,
  `LocalFileSecretStore`) pode ser selecionada sob `NODE_ENV=production` — cada uma recusa-se a
  construir sozinha, e `createRuntimeSecretStore()` (Prompt 039,
  `src/modules/provisioning/infrastructure/runtime-secret-store.ts`) centraliza essa decisão
  para todo entrypoint, lançando explicitamente em produção em vez de selecionar qualquer uma
  das duas. Essa proteção não é enfraquecida por esta ADR.
- Todo entrypoint de produção que depende de `SecretStore` (os workers/dispatchers hoje; a API
  HTTP a partir do Prompt 020) continua recusando-se a iniciar/operar em `NODE_ENV=production`
  até que esta ADR seja implementada.

## Atualização (Prompt 039): `LocalFileSecretStore`, dev-only

Um segundo provider de **desenvolvimento** foi implementado —
`src/modules/provisioning/infrastructure/local-file-secret-store.ts`. Não é uma resposta a esta
ADR (produção continua **PLANNED**, sem nenhum código real): resolve especificamente a
limitação prática de `InMemorySecretStore` não sobreviver a um restart de processo nem ser
compartilhável entre processos locais, que atrapalhava o fluxo de desenvolvimento descrito em
ARCHITECTURE.md ("Local development runtime").

- Persiste secrets como JSON em `env.DEV_SECRET_STORE_PATH` (default
  `.local/secrets.json`, gitignored), com escrita atômica (arquivo temporário + rename) e um
  lock de arquivo simples para serializar `put`/`delete` concorrentes entre processos.
- Nunca selecionado em produção: `createRuntimeSecretStore()` lança
  `ProductionSecretStoreNotConfiguredError` sob `NODE_ENV=production`, independente de
  `DEV_SECRET_STORE_PATH` estar configurado ou não.
- Plaintext, deliberadamente sem criptografia local — é um arquivo de desenvolvimento na
  própria máquina do desenvolvedor; guardar uma chave de criptografia ao lado do arquivo
  criptografado não adicionaria segurança real, apenas complexidade.
- Não muda nenhuma das razões que levaram a esta ADR (rotação, IAM granular, auditabilidade via
  CloudTrail) — nenhuma delas é resolvida, nem seria, por um arquivo local. `LocalFileSecretStore`
  é estritamente uma conveniência de desenvolvimento, nunca um candidato a substituir a decisão
  desta ADR.

## Alternativas consideradas

- **HashiCorp Vault**: viável tecnicamente, mas exigiria operar infraestrutura própria adicional
  (ou um serviço gerenciado à parte) sem vantagem concreta sobre um provider gerenciado nativo
  da nuvem alvo — rejeitada por complexidade operacional desproporcional para esta fase.
- **Variáveis de ambiente/arquivo de configuração criptografado**: rejeitada por não oferecer
  rotação, IAM granular ou auditabilidade — reintroduziria, na prática, o mesmo tipo de risco
  que `SecretStore` foi desenhado para evitar.
