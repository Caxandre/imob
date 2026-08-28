# ADR-008: Asynchronous Property Image Processing

## Status

Aceito. Implementação: **PLANNED / DESIGNED** (Prompt 029) — esta ADR define a arquitetura;
nenhum código de processamento de imagem é implementado nesta tarefa. `sharp` é o provider
escolhido, mas **não instalado**.

## Context

Desde o Prompt 027, `POST /api/v1/properties/:id/media` grava o arquivo original enviado pelo
cliente em Cloudflare R2 (ADR-006) e persiste metadados em `property_media` (Tenant Data Plane).
O frontend hoje só teria acesso ao arquivo original — sem variantes redimensionadas — para
qualquer contexto de exibição (card de listagem, thumbnail de galeria, detalhe do imóvel).
Servir sempre o original é desperdício de banda/latência para contextos que precisam de uma
imagem muito menor, e não há hoje nenhum mecanismo para derivar variantes.

A plataforma já possui a infraestrutura que uma solução de processamento de imagem precisaria:
Cloudflare R2 para armazenar binários (ADR-006), BullMQ + Redis para trabalho assíncrono
confiável (ADR-002, já usado pelo provisionamento de tenant), e um Tenant Data Plane isolado por
database (ADR-001) onde metadados adicionais podem viver. Falta decidir como essas peças se
compõem para processamento de imagem — e, antes de instalar uma dependência nativa (`sharp`) ou
desenhar uma nova tabela, registrar essa decisão explicitamente.

## Decision

**Processamento assíncrono**, nunca dentro da requisição HTTP de upload:

```text
sharp (transformação) + BullMQ (execução assíncrona) + Cloudflare R2 (storage) + PostgreSQL
(metadados no Tenant Data Plane)
```

Rejeitado explicitamente: redimensionar todas as variantes de forma síncrona dentro do próprio
`POST .../media`, devolvendo a resposta HTTP só depois de gerar/enviar todas as variantes ao R2.
Isso multiplicaria a latência do upload pelo número de variantes e pelo custo de CPU do
`sharp`, tornando o tempo de resposta do upload proporcional a um trabalho que o cliente do
upload não precisa esperar para terminar.

## Architecture

### Processing flow

```text
HTTP upload (síncrono, inalterado desde o Prompt 027)
    ↓
original no R2 (ObjectStorage.putObject)
    ↓
property_media persistido (status inicial: ver seção "property_media status" abaixo)
    ↓
enqueue image-processing job (BullMQ) — best-effort, nunca dentro da transação PostgreSQL
    ↓
HTTP termina (201, sem esperar nenhuma variante)

BullMQ (assíncrono, processo separado)
    ↓
Image Processing Worker
    ↓
download do original (ObjectStorage — ver "ObjectStorage no worker" abaixo)
    ↓
sharp: decode → orientação EXIF → resize (por variante) → encode WebP
    ↓
upload de cada variante ao R2
    ↓
persistir metadata de cada variante (property_media_variants)
    ↓
media → READY (ou FAILED em erro permanente)
```

A latência normal de upload HTTP não aumenta: o request/response ciclo termina assim que o
original está no R2 e a linha de `property_media` existe — o mesmo contrato que já existe hoje
(Prompt 027), sem nenhuma mudança de comportamento observável no upload em si além do enqueue.

### Original preservation

O arquivo original enviado pelo cliente **é sempre preservado** no R2, indefinidamente — nunca
descartado após gerar variantes. Motivos:

- Reprocessamento futuro sem exigir novo upload do usuário (ver "Reprocessing" abaixo).
- Mudança de resolução/dimensões-alvo das variantes no futuro.
- Mudança de formato de saída (ex.: adotar AVIF além de/no lugar de WebP).
- Correção de um algoritmo de processamento com bug, aplicável retroativamente.
- Geração de novas variantes ainda não previstas hoje.
- Integração futura com portais externos que possam exigir o arquivo original, não uma
  variante derivada com perda.

### Variants

Três presets iniciais, deliberadamente poucos — não dezenas de variantes por mídia:

| Variant     | Largura máxima | Uso pretendido                          |
|-------------|-----------------|------------------------------------------|
| `THUMBNAIL` | 320px           | Miniaturas de galeria                    |
| `CARD`       | 640px           | Cards de listagem                        |
| `DETAIL`    | 1280px          | Página de detalhe do imóvel              |
| (original)  | —               | Download explícito apenas, se necessário |

`withoutEnlargement: true` em todo resize — uma imagem menor que a variante-alvo nunca é
ampliada artificialmente; a variante resultante fica com as mesmas dimensões do original (ou a
variante deixa de fazer sentido para essa mídia — decisão de implementação futura, não fechada
aqui). Aspect ratio original é sempre preservado — nunca stretch. **Nenhum crop automático**
nesta primeira arquitetura: cada variante é um redimensionamento proporcional simples, nunca um
recorte de composição.

Formato derivado: **WebP**, qualidade inicial **82** — um valor razoável e amplamente usado como
padrão para fotografia (boa relação tamanho/qualidade percebida) sem micro-otimização por tipo
de conteúdo; se experiência real mostrar necessidade de ajuste, revisitar com dados reais, não
nesta ADR. O original mantém o formato aceito no upload (JPEG/PNG/WebP, `ALLOWED_PROPERTY_MEDIA_MIME_TYPES`
já existente) — nunca convertido no lugar.

**EXIF**: o processamento deve aplicar a orientação visual correta (o `sharp` faz isso via
`.rotate()` sem argumentos, lendo o EXIF `Orientation` e "queimando" a rotação no pixel), mas as
variantes geradas **não devem preservar metadata EXIF desnecessária** — em especial, nunca GPS,
dados de câmera, ou qualquer metadata pessoal do arquivo original deve sobreviver para uma
variante pública servida via CDN/URL pública. Isso é tanto uma questão de tamanho de arquivo
quanto de privacidade (evitar vazar localização de captura de uma foto de imóvel, por exemplo).

**Canal alpha**: PNG/WebP com transparência podem existir entre os originais aceitos hoje.
Nenhuma decisão destrutiva (flatten automático sobre um fundo, remoção forçada do canal alpha) é
tomada nesta ADR sem necessidade concreta — a implementação futura deve preservar transparência
por padrão ao converter para WebP (que suporta alpha nativamente), a menos que um caso de uso
real exija o contrário.

**Imagens animadas**: GIF já não é aceito hoje (`ALLOWED_PROPERTY_MEDIA_MIME_TYPES`). WebP
animado é tecnicamente possível de ser enviado como `image/webp`. A primeira implementação trata
apenas imagens estáticas — se o `sharp` detectar múltiplos frames/animação em um upload,
a implementação futura deve **rejeitar explicitamente** (erro controlado), não processar apenas
o primeiro frame silenciosamente. Suporte a animação fica como evolução futura não planejada
aqui.

### Storage layout

O original continua na key já em produção desde o Prompt 027:

```text
tenants/<tenantId>/properties/<propertyId>/<mediaId>.<ext>
```

Variantes usam um prefixo derivado do `mediaId`, sob o mesmo contexto técnico — nunca o filename
original do cliente:

```text
tenants/<tenantId>/properties/<propertyId>/<mediaId>/thumbnail.webp
tenants/<tenantId>/properties/<propertyId>/<mediaId>/card.webp
tenants/<tenantId>/properties/<propertyId>/<mediaId>/detail.webp
```

**Compatibilidade com mídia existente**: nenhuma key existente é alterada nesta tarefa nem é
exigido migrar/mover objetos já presentes no R2. A arquitetura futura precisa considerar que
mídias já enviadas antes desta ADR têm sua key de original no formato
`.../<mediaId>.<ext>` (arquivo direto, sem subpasta) — esse formato continua válido
indefinidamente para o original; variantes futuras (para mídia antiga ou nova) usam o prefixo
`<mediaId>/` acima, que nunca colide com a key plana do original porque uma é um arquivo e a
outra é um prefixo de "diretório" (R2/S3 não tem diretórios reais, mas as duas keys nunca são
iguais literalmente). Uma eventual reorganização das keys de original (por exemplo, mover
`.../<mediaId>.jpg` para `.../<mediaId>/original.jpg` por consistência) é **opcional e
separada** desta arquitetura — não é um requisito para processar variantes, e não é decidida
aqui.

### Database model planned

Não adicionar `thumbnail_url`/`card_url`/`detail_url` diretamente em `property_media` — isso
colidiria com "0 ou N variantes por mídia" (uma mídia pode estar `PROCESSING` sem nenhuma
variante ainda, ou `FAILED` permanentemente sem nenhuma) e cresceria mal se um preset futuro for
adicionado. Planejar uma tabela nova, `property_media_variants`, modelo conceitual:

```text
id               uuid, PK
property_media_id uuid, FK → property_media.id, ON DELETE CASCADE
variant          enum (THUMBNAIL | CARD | DETAIL)
object_key       text, único junto com property_media_id
public_url       text
mime_type        text
width            integer
height           integer
size_bytes       bigint
created_at       timestamptz
updated_at       timestamptz

UNIQUE(property_media_id, variant)
```

`ON DELETE CASCADE` nesta FK é aceitável — diferente da FK `property_media.property_id →
properties.id` (`RESTRICT`, porque uma propriedade nunca é fisicamente deletada e a mídia tem
valor/histórico próprio), uma variant não tem nenhum valor independente da mídia que a originou:
ela é inteiramente derivada e reproduzível a partir do original, então quando a linha de
`property_media` deixar de existir (cenário hoje inexistente — hoje só existe archive de
`properties`, nunca exclusão física de `property_media` — mas o Prompt 045 futuro já prevê
consequência sobre isso, ver "Consequência para o Prompt 028 — delete" abaixo), suas variants
deixarem de existir junto é o comportamento correto, não uma perda de dado real.

**`tenant_id` nunca é adicionado** a `property_media_variants` — mesma regra de todas as demais
tabelas do Tenant Data Plane (ADR-001/CLAUDE.md): o isolamento continua sendo o boundary do
database físico, nunca uma coluna discriminadora.

**`property_media.status`**: avaliada e preferida a adição futura de um estado explícito —
`PROCESSING` / `READY` / `FAILED` — não implementada nesta tarefa (nenhuma migration).

```text
upload do original bem-sucedido → property_media.status = PROCESSING
todas as variantes concluídas   → READY
falha terminal (permanente)     → FAILED
```

A mídia **fica disponível no sistema durante `PROCESSING`** — o original já está acessível via
`public_url` normalmente, a mídia aparece na listagem — mas o frontend deve poder distinguir os
três estados (por exemplo, para mostrar um placeholder/skeleton em vez da variante ainda
inexistente) via o `status` retornado pela API. Nenhuma rota nova ou mudança de contrato HTTP é
implementada nesta tarefa; ver "Public API strategy" abaixo para a forma futura considerada,
deliberadamente não fechada aqui.

### Queue and worker

Fila BullMQ distinta da fila de provisionamento (`tenant-provisioning`) — nunca reaproveitada:

```text
queue: media-processing
job:   process-property-media
```

**Payload mínimo**, mesmo princípio já aplicado a `ProvisionTenantJobPayload` (ADR-002):
PostgreSQL/R2 continuam a fonte de verdade, o job só precisa de identificadores suficientes para
localizar tudo de novo — nunca credenciais, nunca a URL pública, nunca os bytes da imagem:

```ts
interface ProcessPropertyMediaJobPayload {
  tenantId: string;
  propertyId: string;
  mediaId: string;
}
```

Explicitamente fora do payload: credenciais de R2, senha/connection string de database, URL
pública, e os bytes brutos da imagem (o worker sempre busca o original de volta do R2 pelo
`object_key` já persistido, nunca recebe o binário através do Redis/BullMQ).

**Resolução do Tenant Data Plane**: o worker nunca recebe uma credencial de tenant através do
job — ele resolve, a partir de `tenantId`, exatamente o mesmo caminho que a API HTTP já usa hoje
(`TenantDatabaseResolver` → credencial de aplicação do tenant → `TenantDatabaseConnectionManager`
→ database do tenant). Nenhuma credencial administrativa do cluster é usada pelo worker de
processamento — mesma regra permanente já aplicada a todo runtime de negócio de tenant
(CLAUDE.md).

**`ObjectStorage` no worker**: o worker consome a mesma porta `ObjectStorage` já usada pela API
(nunca o SDK do R2/`@aws-sdk/client-s3` diretamente) — mesmo boundary porta/adapter do ADR-006.
Para obter os bytes do original, o port provavelmente precisará evoluir com um método
`getObject(key)` (hoje só existem `putObject`/`deleteObject`) — **não implementado nesta
tarefa**; registrado aqui como necessidade futura conhecida, a ser adicionada quando a
implementação real do worker começar.

### Idempotency

O processamento precisa ser idempotente: se o job `process-property-media` rodar duas vezes
(redelivery do BullMQ, retry manual, ou uma reclaim futura análoga à do provisionamento —
ADR-003 "Recovery"), o resultado final para `THUMBNAIL`/`CARD`/`DETAIL` de uma mesma mídia deve
convergir para o mesmo estado lógico, nunca duplicar trabalho de forma observável.

**Deterministic object keys**: cada variante usa uma key fixa e previsível
(`.../<mediaId>/card.webp`, nunca um UUID novo gerado a cada tentativa) — isso é o que torna o
retry seguro: uma segunda execução sobrescreve exatamente o mesmo objeto no R2, nunca cria um
segundo objeto órfão ao lado do primeiro. Comportamento assumido do R2 (compatível S3): um
`PutObject` para uma key existente substitui o conteúdo atomicamente do ponto de vista de quem
lê depois — não há uma janela onde a key aponta para "nada"; um leitor concorrente vê a versão
antiga ou a nova, nunca um objeto corrompido/parcial. Isso reduz o risco de objetos órfãos
comparado a uma estratégia de key aleatória por tentativa.

**Upsert de metadata**: `UNIQUE(property_media_id, variant)` em `property_media_variants` é o
que torna a persistência de metadata idempotente — a implementação futura deve fazer
upsert/reconcile (`INSERT ... ON CONFLICT (property_media_id, variant) DO UPDATE`) sobre essa
constraint, nunca um `INSERT` simples que falharia em um retry. Um retry nunca deve criar uma
segunda linha para a mesma `(mídia, variant)`.

**Ordem de consistência por variante** — mesmo princípio assimétrico já registrado no ADR-007,
aplicado aqui por variante individual:

```text
processar buffer (sharp)
    ↓
upload da variante ao R2
    ↓
persistir metadata da variante (upsert)
```

Se a persistência de metadata falhar depois do upload da variante ter sucesso, a decisão
preferida — análoga ao ADR-007 "Upload" — é permitir reprocessamento determinístico: como a key
da variante é sempre a mesma, um retry subsequente do job simplesmente reenvia (sobrescrevendo)
a mesma key e tenta persistir a metadata de novo, sem exigir uma exclusão compensatória
explícita como no fluxo de upload do original. Uma compensação ativa (deletar a variante do R2
se a metadata falhar) é uma alternativa válida e não descartada, mas a decisão desta ADR é que
não é estritamente necessária dado que a key determinística por si só já resolve o caso comum —
detalhe de implementação a confirmar no Prompt que efetivamente implementar o worker.

### Failure handling

Distinguir explicitamente falhas transitórias de falhas permanentes:

**Transient** (deve ser retentado):
- R2 indisponível/timeout durante download do original ou upload de uma variante.
- Erro de rede.
- PostgreSQL indisponível/timeout transitório ao resolver o Tenant Data Plane ou persistir
  metadata de variante.

**Permanent** (não deve ser retentado indefinidamente — falha terminal, `property_media.status =
FAILED`):
- Original inválido/corrompido — `sharp` não consegue decodificar o arquivo.
- Imagem animada detectada sem suporte planejado (ver "Animated images" acima).

Magic bytes já são validados no upload (Prompt 027) — mas o worker, rodando em um processo/tempo
diferente do upload, ainda precisa tratar uma falha de decode do `sharp` como um erro controlado
e classificado, nunca deixar uma exceção não tratada derrubar o worker inteiro ou reprocessar
infinitamente um arquivo genuinamente corrompido.

**BullMQ retry**: ao contrário do padrão `attempts: 1` explícito já usado pela fila de
provisionamento (ADR-002 — que delega toda recuperação a um mecanismo de execution
lease/recovery próprio, fora do BullMQ), processamento de imagem é uma carga de trabalho
diferente e não deve herdar esse padrão automaticamente. A arquitetura aqui planeja retries do
BullMQ para erros classificados como transient, com **exponential backoff** — valores concretos
(número de tentativas, backoff inicial/máximo) ficam para o Prompt de implementação, não
inventados sem justificativa nesta ADR. Um erro classificado como permanent nunca deve ser
retentado pelo BullMQ (o job handler deve resolver, não rejeitar, um erro permanente já
registrado como `FAILED` — mesmo princípio já usado por `startPendingProvisioningJob`, que
resolve normalmente uma falha de provisioning já persistida como `FAILED`, nunca a propaga como
falha de callback do BullMQ).

### Security

Logs seguros, mesmo princípio de todo o codebase (CLAUDE.md — nunca `console.log`, nunca
segredo/PII desnecessário):

```text
tenantId, mediaId, variant, duration, result
```

Nunca logar: credenciais (R2/database), bytes de imagem, ou qualquer EXIF pessoal extraído do
original (ver "EXIF" acima).

## Operational consequences

**Concurrency**: processamento de imagem é CPU-intensivo (decode + resize + encode via `sharp`,
uma dependência nativa) — o worker de imagem precisa de sua própria configuração de
concorrência, nunca compartilhando diretamente a configuração do worker de provisionamento
(que hoje nem define `concurrency` explícito no `Worker` do BullMQ — usa o default, adequado
para um workload de I/O, não de CPU).

**Process isolation**: preferência é que o media worker seja um **processo separado** do worker
de provisionamento — a topologia de produção futura fica:

```text
API (server.ts)
dispatcher/provisioning workers (provisioning-dispatcher.ts, provisioning-worker.ts)
media worker (novo entrypoint, não implementado nesta tarefa)
```

três famílias de processo independentes, cada uma escalável e reiniciável separadamente —
mesmo princípio de processos independentes já estabelecido para dispatcher/worker de
provisionamento.

**`dev:full`**: esta ADR não decide automaticamente que o media worker deve entrar no runtime
combinado `pnpm dev:full` (que hoje só soma API + provisioning worker, Prompt 021). A
preferência registrada é um entrypoint de conveniência local separado —
`pnpm dev:media-worker` — para representar melhor que o processamento de imagem é uma carga de
CPU independente, não uma soma automática ao runtime combinado existente. Decisão de
implementação, não fechada aqui.

**Native dependency**: `sharp` introduz uma dependência nativa/prebuilt (binários pré-compilados
por plataforma, `libvips` por baixo). A implementação futura precisa validar explicitamente que
os binários corretos são resolvidos em: desenvolvimento Windows, CI Linux (GitHub Actions),
Docker Linux (imagem de produção), Node 22 — antes de assumir que `pnpm add sharp` "só funciona"
em todos esses ambientes.

**Memory limits / decompression bomb**: o upload atual já limita o tamanho do arquivo a 10MB
(`MAX_MEDIA_FILE_SIZE_BYTES`), mas isso não limita a dimensão em pixels de uma imagem — um
arquivo pequeno em bytes pode se decodificar para dimensões enormes (um "decompression bomb"
clássico), consumindo memória desproporcional durante o decode. A implementação futura do
worker deve impor um limite explícito de **pixels de entrada** (ex.: via `sharp({ limitInputPixels:
... })`), nunca confiar apenas no limite de tamanho de arquivo já existente. Processar múltiplas
imagens gigantes simultaneamente também deve ser evitado — outra razão para a concorrência do
worker ser configurada deliberadamente, não deixada no default.

## Public API strategy

Não implementado nesta tarefa. Avaliado, sem fechar o contrato HTTP aqui: a resposta de
`property_media` (ou uma projeção equivalente) precisará, no futuro, expor `processing_status`
e alguma forma de referenciar as variantes disponíveis — por exemplo:

```json
{
  "id": "...",
  "public_url": "...",
  "processing_status": "READY",
  "variants": {
    "thumbnail": "...",
    "card": "...",
    "detail": "..."
  }
}
```

ou uma forma equivalente (array em vez de objeto por chave). Essa decisão de contrato HTTP fica
para o Prompt que implementar o processamento real, com o benefício de já ter um modelo de dados
(`property_media_variants`) e uma constraint (`UNIQUE(property_media_id, variant)`) definidos
aqui para se apoiar.

**Cover** continua referenciando `property_media` diretamente (Prompt 028) — nunca uma variant
específica; o frontend decide qual variant exibir para qualquer contexto (incluindo a capa).
**Reorder** (Prompt 028) permanece inalterado — variantes não têm posição própria, seguem a
mídia que representam.

### Frontend guidance (uso pretendido, não um contrato imposto)

```text
cards de listagem      → CARD
thumbnails de galeria  → THUMBNAIL
detalhe do imóvel      → DETAIL
download/original      → original, só quando explicitamente necessário
```

### CDN

`R2_PUBLIC_URL` continua sendo a forma de servir objetos publicamente, como hoje. Domínio
customizado via CDN permanece **PLANNED**, sem mudança nesta ADR (ADR-006 "Future"). Nenhuma key
(original ou variante) é acoplada ao domínio público — a mesma separação já existente hoje entre
`object_key` (nunca exposto) e `public_url` (derivado, persistido) continua válida.

## Reprocessing

A arquitetura deve permitir reprocessar uma mídia (nova configuração de qualidade/dimensões,
correção de bug no algoritmo, novo preset de variante) **sem exigir novo upload do usuário** —
esse é um dos motivos centrais para preservar o original indefinidamente (ver "Original
preservation" acima). O mecanismo concreto de disparo de reprocessamento (rota administrativa,
job em lote, comando manual) não é decidido nesta ADR.

**Versionamento de processamento**: avaliada a necessidade futura de um campo como
`processing_version` em `property_media`/`property_media_variants`, para saber quais mídias
foram processadas com qual geração de preset quando os presets mudarem. **Não implementado
agora** — registrado como possível evolução quando os presets realmente mudarem pela primeira
vez, não antes.

## Observability (futuro)

Métricas futuras possíveis, não implementadas nesta tarefa: duração de processamento, contagem
de falhas, profundidade da fila. Logs seguros (ver "Security" acima) já são o mínimo esperado
desde a primeira implementação real.

## Consequência para o Prompt 028 — delete

Quando esta arquitetura for implementada, `deletePropertyMedia` (Prompt 028) precisará remover
não só o objeto original, mas **todas as variantes existentes** do R2, best-effort — mesma
ordem de consistência já decidida no ADR-007 "Delete" (metadata primeiro, objetos depois,
best-effort, nunca bloqueando o 204). Isso é uma alteração futura da lógica de delete definida
no Prompt 028, não implementada nesta tarefa — registrada aqui para que a implementação futura
do worker de imagem não esqueça de atualizar `deletePropertyMedia` (e, com `ON DELETE CASCADE`
em `property_media_variants`, a remoção da metadata das variantes já seria automática ao
remover a linha de `property_media` — só a limpeza dos objetos R2 correspondentes precisaria de
código novo).

## Alternatives considered

- **Sharp síncrono dentro do request HTTP de upload**: rejeitado — aumentaria a latência do
  upload proporcionalmente ao número de variantes e ao custo de CPU de cada resize, tornando o
  tempo de resposta do upload dependente de um trabalho que o cliente não precisa esperar.
- **Cloudflare Images**: um produto gerenciado de processamento/entrega de imagem da própria
  Cloudflare existe como opção comercial. Não escolhido nesta ADR — a decisão aqui é usar a
  infraestrutura já operada pela plataforma (R2 + BullMQ + PostgreSQL, já em produção para
  outros fluxos) em vez de adotar mais um serviço gerenciado de terceiro; nenhum dado de custo
  é comparado ou inventado aqui — esta não é uma análise de custo/benchmark formal entre
  providers.
- **Serviço externo de processamento de imagem** (um microserviço dedicado, possivelmente em
  outra linguagem/runtime otimizada para processamento de imagem): rejeitado por ora — introduz
  uma nova peça de infraestrutura operacional (deploy, monitoramento, rede) sem necessidade
  concreta demonstrada; o monólito modular já estabelecido (ARCHITECTURE.md — "Princípios")
  comporta um worker adicional dentro do mesmo código-base sem essa complexidade.
- **Nenhum processamento (servir sempre o original)**: rejeitado — descartaria a razão de ser
  desta tarefa (variantes menores para contextos que não precisam do original completo);
  seguiria funcionando, mas sem os ganhos de banda/latência de servir uma imagem do tamanho
  certo para cada contexto.

## Future triggers

Sinais que justificariam revisitar decisões específicas desta ADR, sem se comprometer com eles
agora:

- Presets de variante (`THUMBNAIL`/`CARD`/`DETAIL`) mudando de dimensão/adicionando um novo
  preset → motivaria implementar `processing_version` (ver "Reprocessing" acima).
- Volume real de objetos órfãos em R2 (originais **e** variantes) → motivaria priorizar um
  processo de reconciliação (já registrado como PLANNED desde o ADR-007, ainda sem
  implementação).
- Necessidade real de crop/composição de imagem (não apenas resize proporcional) → decisão
  arquitetural nova, fora do escopo desta ADR (que explicitamente não faz crop automático).
- Suporte a imagens animadas (WebP animado) sendo um requisito de produto real → decisão nova,
  esta ADR só define rejeição explícita por ora.
- Padrão real de tráfego mostrando que a concorrência default do worker de imagem está incorreta
  (muito baixa = fila crescendo, muito alta = contenção de CPU) → ajustar com dados reais, não
  especulação.
