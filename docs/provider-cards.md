# Model cards por provider (#553)

Layout por provider: cada pasta tem o adapter (endpoint/credencial) e um arquivo de model cards; o catálogo apenas compõe. Detalhe de retry/cota fica em `docs/providers.md`.

| Arquivo | Contém | Não contém |
|---|---|---|
| `src/providers/<provider>/adapter.ts` | `key`, `name`, `kind`, `baseUrl`/`credentialsPath`, `credentialRef`, `quotaDomain` | dado de modelo, segredo |
| `src/providers/<provider>/<provider>_models.ts` | model cards do provider | endpoint, credencial |
| `src/providers/seed.ts` | tipos `ModelCard`/`ProviderAdapterSeed` e `profileModelsFor` | dado de provider específico |
| `src/providers/catalog.ts` | composição dos seeds em `PROVIDER_CATALOG` | dado de modelo inline |

O adapter de fio continua compartilhado por `kind` (`openai-compat.ts`, `codex-oauth.ts`); o `adapter.ts` do provider é o descritor que o wizard e o catálogo leem.

## Contrato do model card

| Campo | Tipo | Regra |
|---|---|---|
| `id` | string | Slug exato do provider |
| `tags` | string[] | Vocabulário de `src/tags.ts` |
| `context` | number | Janela em tokens, > 0 |
| `status` | `active`/`deprecated`/`disabled` | Estado na oferta do provider |
| `reasoning` | boolean | Expõe raciocínio configurável |
| `callMethod` | `chat-completions`/`responses` | Endpoint usado pelo adapter |
| `efforts` | `EffortLevel[]` | Vazio se `reasoning: false`; com reasoning, ≥ 1 nível |
| `price` | `PriceConfig \| null` | `null` = sem curadoria (`n/d`, D-10); `verificado: false` até conferir na fonte |
| `free` | boolean | Gratuito declarado; se `true`, preço 0/0 ou `null` |

`profileModelsFor(cards)` projeta `{id, tags, context}` — o formato que `profiles.ts`/wizard consomem. `CatalogEntry.cards` mantém a ficha completa para a UI de `/provider` (#555) e `astro models list --seeds --json` a expõe (extensão do JSON, #553).

## Invariantes

- I-03: card nunca carrega valor de credencial; só `credentialRef` (nome da variável) e `fonte` (URL pública).
- Paridade (#553): mover um modelo para o layout novo não muda a saída de `PROVIDER_CATALOG` — `tests/provider-layout.test.ts` compara com o snapshot anterior.
