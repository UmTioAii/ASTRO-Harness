# Provider model cards (#553, #601)

Each provider folder holds the adapter (endpoint/credential) and an offer file; model facts live once in `src/models/catalog.ts` and the catalog only composes. The wire adapter stays shared by `kind`; the provider `adapter.ts` is the descriptor read by the wizard and the catalog. Retry/quota detail stays in `docs/providers.md`.

| File | Owns | Does not own |
|---|---|---|
| `src/providers/<provider>/adapter.ts` | `key`, `name`, `kind`, `baseUrl`/`credentialsPath`, `credentialRef`, `quotaDomain` | model facts, price, secret |
| `src/providers/<provider>/<provider>_models.ts` | offers: `ref`, `price`, `free`, `status`, `callMethod`, `overrides` | context, reasoning, efforts, tags |
| `src/models/catalog.ts` | facts: `context`, `maxOutput`, `reasoning`, `efforts`, `tools`, modalities, `tags`; `ModelId` | price, status, endpoint |
| `src/providers/seed.ts` | `ProviderModel`/`ModelCard`/`ProviderAdapterSeed`, `effectiveCard`, `profileModelsFor` | provider-specific data |
| `src/providers/catalog.ts` | composes offers into `PROVIDER_CATALOG` | inline model data |

Precedence: provider override > catalog fact > code default. Editing a fact in `src/models/catalog.ts` changes every offer that points at that `ref`; a gateway divergence becomes an explicit `overrides` entry instead of a copy of the other facts. `effectiveCard` clamps `maxOutput` to the effective `context`.

## Offer (`ProviderModel`)

| Field | Type | Rule |
|---|---|---|
| `ref` | `ModelId` | Curated id in `src/models/catalog.ts`; unknown or misspelled ids do not compile |
| `price` | `PriceConfig \| null` | `null` = uncurated (`n/d`, D-10); `verificado: false` until checked at the source |
| `free` | boolean | Declared free; when `true`, price 0/0 or `null` |
| `status` | `active`/`deprecated`/`disabled` | State in this offer; default `active` |
| `callMethod` | `chat-completions`/`responses` | Adapter endpoint; default `chat-completions` |
| `overrides` | `Partial<ModelFacts>` | Only what the gateway changes; wins over the catalog |

## Facts (`ModelFacts`)

| Field | Type | Rule |
|---|---|---|
| `context` | number | Context window in tokens, > 0 |
| `maxOutput` | number | Output cap in tokens, > 0 and ≤ `context` |
| `reasoning` | boolean | Exposes configurable reasoning |
| `efforts` | `EffortLevel[]` | Empty when `reasoning: false`; otherwise ≥ 1 level |
| `tools` | boolean | Tool calling support |
| `modalities` | `{ input, output }` | `text`/`image`/`audio` |
| `tags` | `Tag[]` | Closed vocabulary from `src/tags.ts`; a typo in a fact or override does not compile (I-21) |

`profileModelsFor(cards)` projects `{id, tags, context}` — the shape `profiles.ts` and the wizard consume. `CatalogEntry.cards` keeps the effective card (facts + overrides) for the `/provider` UI (#555), and `astro models list --seeds --json` exposes it (JSON extension, #553).

## Invariants

- I-03: a card never carries a credential value; only `credentialRef` (variable name) and `fonte` (public URL).
- I-21: a tag outside the vocabulary fails the catalog test; tags are curated once, not per provider.
- Parity (#553): moving a model into the new layout does not change `PROVIDER_CATALOG` output; `tests/provider-layout.test.ts` compares against the previous snapshot.
