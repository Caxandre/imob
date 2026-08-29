# ADR-007: Property Media Consistency Between R2 and PostgreSQL

## Status

Aceito. Implementação: **IMPLEMENTED** (Prompt 027 — upload; Prompt 028 — delete) —
`uploadPropertyMedia`/`deletePropertyMedia`
(`src/modules/properties/application/upload-property-media.ts`,
`src/modules/properties/application/delete-property-media.ts`).

## Context

`POST /api/v1/properties/:id/media` (Prompt 027) grava em dois sistemas diferentes para cada
upload: o binário em Cloudflare R2 (`ObjectStorage.putObject()`, ADR-006) e os metadados
(`property_media`) no PostgreSQL do Tenant Data Plane do tenant. PostgreSQL e R2 **não
compartilham uma transação distribuída** — não existe (e não será construído) um coordenador de
duas fases entre eles. Isso significa que uma falha entre as duas escritas é uma possibilidade
real, não hipotética, e o comportamento correto precisa ser uma decisão explícita, não um
acidente de ordem de código.

## Decision

**Upload primeiro, insert no banco depois; compensação best-effort (delete) se o insert
falhar. Nunca o inverso.**

```text
validar property (existe, não está INACTIVE)
    ↓
gerar mediaId + object key (IDs técnicos, servidor)
    ↓
ObjectStorage.putObject()          ← binário grava primeiro
    ↓ (sucesso)
INSERT property_media               ← metadados gravam depois
    ↓ (falha)
ObjectStorage.deleteObject()  (compensação best-effort)
```

`property_media` nunca é escrito antes de o objeto existir de fato em R2 — evita o cenário mais
perigoso (uma linha no banco apontando para um objeto que nunca existiu). O cenário aceito como
imperfeição é o inverso: um objeto órfão em R2 sem uma linha correspondente, quando o insert
falha **e** a compensação também falha.

### Rationale

- **Nunca uma referência quebrada no contrato principal.** Todo `property_media` que existe no
  banco aponta para um objeto real — é a garantia que mais importa para o caminho feliz e para
  a leitura (`GET .../media`), que é o caminho majoritário de uso.
- **A falha do caminho menos provável é a mais tolerável.** Um objeto órfão em R2 (sem row) é
  "só" desperdício de armazenamento — não quebra nenhuma leitura, não expõe um link morto para
  ninguém (nada referencia esse objeto se não há row), e é resolvível por uma reconciliação
  futura. Uma row sem objeto quebraria a UI/API imediatamente para qualquer leitor.
- **Sem transação distribuída para inventar.** Duas-phase commit entre PostgreSQL e um object
  storage S3-compatível é uma complexidade real de infraestrutura (coordenador, log de
  recuperação, timeouts) desproporcional ao problema — a estratégia upload-then-insert com
  compensação resolve o caso comum sem essa infraestrutura.

## Consequences

- Uma falha simultânea de "insert falhou" + "delete compensatório também falhou" deixa um
  objeto órfão real em R2. `PropertyMediaPersistError.compensated === false` sinaliza esse caso
  no log estruturado (nunca escondido — CLAUDE.md) — mas nenhuma reconciliação automática existe
  ainda.
- O erro original do banco é sempre preservado como `.cause`, nunca substituído pelo resultado
  da tentativa de compensação (sucesso ou falha) — quem depura precisa do motivo real da falha,
  não apenas do resultado da limpeza.
- Toda a lógica de compensação vive na camada de aplicação (`uploadPropertyMedia`), nunca no
  `ObjectStorageRepository`/adapter — o adapter R2 continua sem saber nada sobre
  `property_media` ou sobre "compensação" como conceito.
- Nenhuma tentativa de retry automático do insert existe nesta tarefa — uma falha de insert
  propaga imediatamente após a tentativa de compensação, como `PropertyMediaPersistError` (500).

## Delete (Prompt 028)

`DELETE /api/v1/properties/:id/media/:mediaId` também grava nos dois sistemas — mas na **ordem
oposta** ao upload, deliberadamente.

```text
lock property (SELECT ... FOR UPDATE)
    ↓
DELETE property_media (ON DELETE CASCADE remove property_media_variants — Prompt 030/032)
    + reindex posições + promoção de capa                     ← metadados removem primeiro,
    ↓ (commit da transação)                                      tudo em uma transação
ObjectStorage.deleteObject() para o original E cada variante   ← objetos reais removem depois,
    (best-effort, independente, nunca refeito — Prompt 032)       um a um, best-effort
```

**Atualizado pelo Prompt 032**: a exclusão remove best-effort não só o objeto original, mas
**toda variante já gerada** (`THUMBNAIL`/`CARD`/`DETAIL`) — o repositório lê os `object_key` das
variantes de `property_media_variants` *antes* do `DELETE` que dispara o `ON DELETE CASCADE`
(as linhas de variant já teriam sumido depois), e a camada de aplicação tenta remover cada key —
original e cada variante — de forma independente: uma falhando nunca impede a tentativa das
outras. Zero variantes é um resultado normal (mídia nunca processada, ou ainda
`PROCESSING`/`FAILED`) — a exclusão nunca assume um número fixo de variantes.

Aqui a assimetria com o upload é a decisão central, não um detalhe: no upload, o pior cenário
tolerável é um objeto órfão em R2 (sem row) — por isso o objeto é escrito primeiro. Na exclusão,
o pior cenário tolerável é exatamente o mesmo tipo de órfão, só que alcançado pelo caminho
inverso: **remover a row primeiro, depois tentar remover o objeto**, porque a alternativa —
apagar o objeto primeiro e só depois a row — arrisca deixar `property_media` apontando para um
arquivo que já não existe caso a segunda etapa falhe. Uma row órfã apontando para nada é pior do
que um objeto órfão sem row: a primeira quebra imediatamente qualquer leitor (`GET .../media`,
qualquer front-end servindo `public_url`); a segunda é só desperdício de armazenamento, invisível
para qualquer consumidor da API.

Consequências específicas da exclusão, em paralelo às já registradas acima para o upload:

- Se a transação PostgreSQL falhar (media inexistente/de outra propriedade, tenant não
  encontrado, etc.), `ObjectStorage.deleteObject()` **nunca é chamado** — o erro propaga direto
  de `PropertyMediaRepository.delete()`, antes de a camada de aplicação sequer tentar tocar o R2.
- Se a transação commitar mas `ObjectStorage.deleteObject()` falhar para uma ou mais keys
  (original e/ou alguma variante), a requisição HTTP ainda retorna **204** — nunca 503/500 por
  causa disso. As falhas são logadas de forma segura (bucket implícito no adapter, as keys que
  falharam, `mediaId` — nunca segredos) para permitir reconciliação futura; cada objeto órfão
  resultante cai na mesma categoria "Future → Reconciliação de órfãos" já prevista abaixo, agora
  alimentada por três caminhos (insert-falhou-e-compensação-falhou no upload,
  delete-do-original-falhou, delete-de-alguma-variante-falhou) em vez de um só.
- A remoção da row, o reindex gapless de `position` (`0..N-1`) e a eventual promoção de uma nova
  capa acontecem todos dentro da mesma transação (protegida pelo lock de linha em `properties`
  já usado por `create`/`reorder`/`setCover`) — nunca como passos separados que poderiam
  observar um estado intermediário inconsistente.

## Future

- **Reconciliação de órfãos**: um processo (batch/scheduled) que varre R2 por objetos sob
  `tenants/.../properties/...` sem `property_media` correspondente e os remove — não
  implementado, não necessário até haver evidência real de acúmulo.
- **Retry do insert** antes de compensar, se falhas transitórias de banco (não sob controle da
  aplicação) se mostrarem comuns o suficiente para justificar a complexidade.
