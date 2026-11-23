# Model cards por provider (#553, #601)

Layout por provider: cada pasta tem o adapter (endpoint/credencial) e um arquivo de ofertas; os fatos do modelo vivem uma vez em `src/models/catalog.ts` e o catálogo apenas compõe. Detalhe de retry/cota fica em `docs/providers.md`.

| Arquivo | Contém | Não contém |
|---|---|---|
| `src/providers/<provider>/adapter.ts` | `key`, `name`, `kind`, `baseUrl`/`credentialsPath`, `credentialRef`, `quotaDomain` | fato de modelo, preço, segredo |
| `src/providers/<provider>/<provider>_models.ts` | ofertas: `ref`, `price`, `free`, `status`, `callMethod`, `overrides` | contexto, reasoning, efforts, tags |
| `src/models/catalog.ts` | fatos curados: `context`, `maxOutput`, `reasoning`, `efforts`, `tools`, modalidades, `tags`; `ModelId` | preço, status, endpoint |
| `src/providers/seed.ts` | tipos `ProviderModel`/`ModelCard`/`ProviderAdapterSeed`, `effectiveCard`, `profileModelsFor` | dado de provider específico |
| `src/providers/catalog.ts` | composição das ofertas em `PROVIDER_CATALOG` | dado de modelo inline |

Precedência: override do provider > fato do catálogo > default do código. Editar um fato em `src/models/catalog.ts` muda toda oferta que aponta para aquele `ref`; divergência de gateway vira `overrides` explícito, sem copiar os demais fatos.

O adapter de fio continua compartilhado por `kind` (`openai-compat.ts`, `codex-oauth.ts`); o `adapter.ts` do provider é o descritor que o wizard e o catálogo leem.

## Contrato da oferta (`ProviderModel`)

| Campo | Tipo | Regra |
|---|---|---|
| `ref` | `ModelId` | Id curado em `src/models/catalog.ts`; id desconhecido ou com erro de digitação não compila |
| `price` | `PriceConfig \| null` | `null` = sem curadoria (`n/d`, D-10); `verificado: false` até conferir na fonte |
| `free` | boolean | Gratuito declarado; se `true`, preço 0/0 ou `null` |
| `status` | `active`/`deprecated`/`disabled` | Estado na oferta; default `active` |
| `callMethod` | `chat-completions`/`responses` | Endpoint usado pelo adapter; default `chat-completions` |
| `overrides` | `Partial<ModelFacts>` | Só o que o gateway muda; vence o fato do catálogo |

## Contrato do fato (`ModelFacts`)

| Campo | Tipo | Regra |
|---|---|---|
| `context` | number | Janela em tokens, > 0 |
| `maxOutput` | number | Teto de saída em tokens, > 0 e ≤ `context` |
| `reasoning` | boolean | Expõe raciocínio configurável |
| `efforts` | `EffortLevel[]` | Vazio se `reasoning: false`; com reasoning, ≥ 1 nível |
| `tools` | boolean | Suporta tool calling |
| `modalities` | `{ input, output }` | `text`/`image`/`audio` |
| `tags` | string[] | Vocabulário de `src/tags.ts` (I-21) |

`profileModelsFor(cards)` projeta `{id, tags, context}` — o formato que `profiles.ts`/wizard consomem. `CatalogEntry.cards` mantém a ficha efetiva (fatos + override) para a UI de `/provider` (#555) e `astro models list --seeds --json` a expõe (extensão do JSON, #553).

## Invariantes

- I-03: card nunca carrega valor de credencial; só `credentialRef` (nome da variável) e `fonte` (URL pública).
- I-21: tag fora do vocabulário falha o teste do catálogo; tag é curada uma vez, não por provider.
- Paridade (#553): mover um modelo para o layout novo não muda a saída de `PROVIDER_CATALOG` — `tests/provider-layout.test.ts` compara com o snapshot anterior.
