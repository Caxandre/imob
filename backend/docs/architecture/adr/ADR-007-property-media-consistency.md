# ADR-007: Property Media Consistency Between R2 and PostgreSQL

## Status

Aceito. Implementação: **IMPLEMENTED** (Prompt 027) — `uploadPropertyMedia`
(`src/modules/properties/application/upload-property-media.ts`).

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

## Future

- **Reconciliação de órfãos**: um processo (batch/scheduled) que varre R2 por objetos sob
  `tenants/.../properties/...` sem `property_media` correspondente e os remove — não
  implementado, não necessário até haver evidência real de acúmulo.
- **Retry do insert** antes de compensar, se falhas transitórias de banco (não sob controle da
  aplicação) se mostrarem comuns o suficiente para justificar a complexidade.
