# ADR-006: Cloudflare R2 Object Storage

## Status

Aceito. Implementação: **IMPLEMENTED** (Prompt 026) — `ObjectStorage` port + Cloudflare R2
adapter. Nenhum consumidor real ainda (property media é **PLANNED**, Prompt 027).

## Context

A aplicação precisa armazenar fotos e outros objetos binários de imóveis fora do PostgreSQL —
guardar binários em uma coluna de banco relacional (`bytea`) infla o tamanho do database,
degrada backups/replicação, e não oferece nada equivalente a uma URL pública direta para servir
o arquivo. Antes de desenhar `property_media` e os endpoints HTTP de upload (Prompt 027), a
fundação de storage real precisa existir e estar testável de forma isolada.

## Decision

**Cloudflare R2, via API compatível com S3** (`@aws-sdk/client-s3`).

## Boundary

Código de domínio/aplicação depende exclusivamente de `ObjectStorage`
(`src/infrastructure/object-storage/object-storage.ts`) — `putObject`/`deleteObject`, tipos
independentes de provider (`PutObjectInput`/`StoredObject`), e um conjunto de erros
provider-agnostic (`ObjectStorageConfigurationError`/`ObjectStorageUploadError`/
`ObjectStorageDeleteError`). `@aws-sdk/client-s3` (`S3Client`/`PutObjectCommand`/
`DeleteObjectCommand`) é importado **somente** dentro do adapter
(`cloudflare-r2-object-storage.ts`) — o mesmo padrão porta/adapter já usado para `SecretStore`
(ADR-003/ADR-004) e para o Tenant Data Plane (ADR-001).

## Rationale

- **Object storage é o padrão certo para binários.** Fotos/documentos não são dados
  relacionais — pertencem a um object store com URL, não a uma linha de tabela.
- **Compatibilidade S3.** R2 fala o mesmo protocolo que a maioria das ferramentas/bibliotecas já
  suporta (`@aws-sdk/client-s3`), incluindo qualquer client de terceiros que a aplicação venha a
  precisar no futuro — sem lock-in a um SDK proprietário de um único provider.
- **Desacoplamento do domínio.** A porta `ObjectStorage` garante que trocar de provider (se algum
  dia necessário) nunca exige tocar em código de domínio/aplicação — só escrever um novo adapter
  atrás da mesma interface.
- **URLs públicas.** `R2_PUBLIC_URL` permite servir objetos diretamente, sem que a aplicação
  precise proxiar bytes de imagem através do próprio backend.
- **Provider já escolhido.** Esta ADR registra uma decisão operacional já tomada para esta
  plataforma — não é uma comparação de custo/benchmark entre providers de object storage; nenhum
  dado de custo é inventado aqui.

## Consequences

- Novo provider externo de infraestrutura: disponibilidade do R2 passa a ser uma dependência
  real para qualquer fluxo que grave/leia mídia (ainda inexistente — Prompt 027).
- Credenciais reais (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`) vivem exclusivamente em variáveis
  de ambiente, nunca no código, nunca logadas, nunca no Control Plane — mesmo princípio já
  aplicado a `SecretStore` (ADR-003/CLAUDE.md).
- Metadados de mídia (quando `property_media` existir) continuam no PostgreSQL do Tenant Data
  Plane de cada tenant; os binários em si ficam inteiramente fora do banco, no R2.
- Nenhuma migration nesta ADR — nenhuma tabela nova, nenhuma mudança em Control Plane ou Tenant
  Data Plane.
- Diferente de `InMemorySecretStore` (test/dev-only, recusa-se a rodar em produção), o adapter R2
  é válido para `development`/`staging`/`production` sempre que as env vars estiverem
  configuradas — não existe guard de `NODE_ENV`, porque R2 já é um provider real, não uma
  simulação local.

## Future

Deliberadamente fora do escopo desta ADR, sem tratá-los como obrigatórios agora:

- URLs assinadas (signed URLs) para acesso privado/temporário.
- Domínio customizado para servir objetos via CDN.
- Processamento de imagem (resize, thumbnails).
- Upload multipart para arquivos grandes.
- `property_media` e os endpoints HTTP de upload em si (Prompt 027).

## Alternatives considered

- **AWS S3 diretamente**: tecnicamente equivalente via o mesmo SDK, mas o provider alvo já
  escolhido para esta plataforma é Cloudflare R2 — sem custo de egress do jeito que S3 cobra,
  entre outras razões operacionais que não são o foco desta ADR (decisão de provider já tomada,
  não uma comparação de custo formal).
- **Armazenar binários no PostgreSQL (`bytea`)**: rejeitada — infla o tamanho físico do database,
  degrada backup/replicação, e nenhuma URL pública direta existiria sem a aplicação proxiar cada
  byte.
- **Motor de busca/storage próprio**: fora de escopo — este ADR é sobre object storage, não sobre
  busca (ver [ADR-005](ADR-005-postgresql-full-text-search.md) para a decisão de FTS).
