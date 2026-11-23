# S3 — Model catalog and adapters

> Objective: give each model fact one typed owner while providers retain offers and explicit overrides.

- Status: draft (alpha.5, phase P3)
- Date: 2026-11-21
- Depends on: S1 (profiles)
- Owner files: `src/models/catalog.ts` (new), `src/providers/<p>/<p>_models.ts`,
  `src/providers/seed.ts`, `src/providers/catalog.ts`, `src/model-catalog.ts`

## 1. Goal

One owner per fact. Model facts are curated once and shared by every provider that offers
the model; each provider keeps only its offer and its overrides. A typo in a model id fails
at compile time, not at runtime.

## 2. Three layers

| Layer | File | Owns | Does not own |
|---|---|---|---|
| transport | `src/providers/<p>/adapter.ts` | `kind`, `baseUrl`, auth, `quotaDomain`, account limits | model, price |
| offer | `src/providers/<p>/<p>_models.ts` | models offered, `price`, `free`, `status`, `callMethod` override | context, reasoning |
| facts | `src/models/catalog.ts` | `context`, `maxOutput`, `reasoning`, `efforts`, `tools`, modalities, tags | price, account |

`src/models/catalog.ts` is the single file of model facts: editing `deepseek-v3.3` once
applies to nvidia, openrouter and any other provider exposing it. Full cards inside each
provider folder would duplicate `context`, `reasoning` and `efforts` until one silently
diverged.

## 3. Compile-time guarantee

`ref` is typed as `ModelId`, the union of catalog ids. An unknown model or a misspelled id
does not compile.

```ts
// src/providers/openrouter/openrouter_models.ts
export const MODELS = [
  { ref: "deepseek/deepseek-v3.3", price: { inputPerM: 0.27, outputPerM: 1.1 } },
  { ref: "meta/llama-3.3-70b", price: null },   // no curated price -> n/d
] as const satisfies readonly ProviderModel[];
```

## 4. Overrides are the rule, not the exception

Gateways truncate context, hide reasoning, drop `effort` or change `maxOutput`. The offer
carries `overrides?: Partial<ModelFacts>`:

```ts
{ ref: "gpt-5.5",
  price: { inputPerM: 0.27, outputPerM: 1.1 },
  overrides: { maxOutput: 8192, reasoning: false, efforts: [] } }   // this gateway exposes no effort
```

Precedence: **provider override > catalog fact > code default**. The override is visible:
`astro doctor` and `/usage` show "context 128k (provider limits to 64k)" instead of letting
the user discover it in a 400 response. A declared capability is validated before the call.

## 5. Four things are called "catalog" today

| Today | What it is | Fate |
|---|---|---|
| `src/model-catalog.ts` | effective catalog derived from config (#307), used by listing and `/model` | stays; reads facts from `src/models/catalog.ts` |
| `src/providers/catalog.ts` | composes seeds into `PROVIDER_CATALOG` | stays; composes `<p>_models.ts` offers |
| `src/providers/seed.ts` | `ModelCard`/`ProviderAdapterSeed` types + `profileModelsFor` | types move to the catalog; `price` moves to the offer |
| `src/models/catalog.ts` | **new** | becomes the only owner of model facts |

Without this table the implementation creates a fifth concept and nobody knows which is true.

## 6. Naming

The offer file keeps the convention already fixed by #553 in `docs/provider-cards.md:8` and
implemented in `codex`, `nvidia` and `openrouter`: `<p>_models.ts`. No folder rename to
accommodate a roadmap draft.

## 7. Acceptance

- [ ] `ModelId` rejects an unknown model id at compile time.
- [ ] A provider override wins over the catalog fact and is shown by `astro doctor`.
- [ ] A model without a curated price shows `n/d` and never zero.
- [ ] Editing one catalog entry changes the behaviour of every provider offering that model.
- [ ] Exactly one file owns `context`, `reasoning` and `efforts` for each model.

## 8. Out of scope

New providers, price scraping, an external snapshot dependency (curated by hand, as decided),
agent routing (S4).
