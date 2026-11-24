# Web tools

Summary: `web_search` queries a configurable backend chain and returns deduplicated, stably citable results; `search_and_read` adds bounded page reads; `web_fetch` downloads one page. External content is untrusted and never executed.

## Configuration (`webSearch`)

| Field | Required | Default | Rule |
|---|---|---|---|
| `provider` | yes | — | `exa`, `brave`, `google` or `custom` |
| `apiKeyEnv` | yes | — | **name** of an environment variable; a value that looks like a secret is rejected (I-03) |
| `baseUrl` | `custom` only | backend endpoint | `http(s)` without credential/metadata; in `google` it may carry `cx` |
| `defaultMaxResults` | no | 5 | integer 1..10 |
| `fallback` | no | — | ordered list of `{provider, apiKeyEnv?, baseUrl?}`, tried after the primary (#604) |

Each fallback entry repeats the key rule (a name, never a value) and may declare its own `baseUrl` under the same URL rules as the primary. The chain may not repeat a backend, including the primary. `custom` enters the chain only when it declares `baseUrl`, because it has no default endpoint. An entry without `apiKeyEnv` has no credential and is skipped. The key is read from the run `env` at call time. No other host variable reaches the backend; the `web.search` audit records `{query, provider, resultsCount, duration, status, cacheHit, backends, backendsTotal}` with the query redacted.

## Declared fallback (#604)

Only transport failures move to the next backend: a network error after the retries, a non-2xx final status, or a 2xx with an unparseable body. A missing credential (or a missing `apiKeyEnv`) skips only that backend. Cancellation stops the chain and audits the in-flight backend with `aborted`. An empty result list is a success, not a failure. Every backend the call considered is audited in `backends` with `{provider, status, durationMs, reason?}`, where `reason` is a bounded code: `credential_missing`, `network`, `invalid_body`, `aborted` or `http_<status>`. Never a credential, a message or a URL. `backendsTotal` is how many backends the call considered.

## Backends

| Provider | Request | Key |
|---|---|---|
| `exa` | `POST {baseUrl}/search` with `contents.text` | header `x-api-key` |
| `brave` | `GET {baseUrl}/res/v1/web/search?q=&count=` | header `X-Subscription-Token` |
| `google` | `GET {baseUrl}` with `key`, `q`, `num` and `dateRestrict` | query `key` (Google contract) |
| `custom` | `POST {baseUrl}` with `{query,maxResults,recencyDays}` | header `Authorization: Bearer` |

Redirects are not followed (`redirect: "error"`): the key never reaches another host.

## Results: canonical URL, citations and cache (#604)

- **Canonical URL** — comparison only: `http` is compared as `https`, host lowercased, default port, fragment and tracking parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`, …) dropped, query sorted, trailing slash removed. A group keeps the position of its first occurrence; url, title and snippet always come from one entry (the longest snippet wins), never a mix. Returned URLs keep the scheme the backend sent, and backend order is preserved.
- **Cap** — results are sliced to `maxResults` before dedupe, so a provider that ignores the limit cannot inflate the list or what the run pins in memory.
- **Citations** — every result carries a numeric `id`, injected after dedupe. The manifest tells the model to cite `[n]`. Ids are unique inside a run and restart at 1 in a new run; a cache hit replays the same ids, so a citation always maps to a result actually returned in that run.
- **Cache** — bounded (32 entries, oldest evicted) and in memory, keyed by a SHA-256 digest of the resolved backend (provider and `baseUrl`), canonical query (case/whitespace insensitive) and the call options: the query text never becomes a key, so a pasted secret is not retained by the `Map`, and two queries that both redact to the same display text stay distinct. A fallback result is stored and read under the backend that answered, never served as a primary hit. An identical call inside the same run is answered from the cache without requesting the backend that produced it (`cacheHit: true`); only successful calls are cached, so when a fallback produced the entry the earlier backends are probed again first and spend their retry budget before the hit. A call without the configured credential fails (or skips that backend) and is audited even when an entry exists; the cache and the id counter are cleared when the tool serves a different `run`.
- Only successful calls are cached; errors and aborted calls never are.

## `search_and_read` (#604)

`{query, maxResults?, recencyDays?, depth?}` runs `web_search` and reads the top `depth` results through the same fetch path as `web_fetch` (no browser, no JavaScript). `depth` is an integer 1..5, default 3; anything else is rejected with the `invalid` failure code before any network call. Results keep the search `[n]` ids, and the delegated search keeps the same dedupe, cache and declared fallback. The page text is untrusted and attached as `content`; a read that fails does not fail the tool when another page succeeded, and its result carries a bounded `readError`: `invalid_url`, `network`, `http_<status>` or `content_type`.

The output is a JSON envelope capped by `manifest.output` and the session cap (S6, `docs/tools-contract.md`). Page text is cut, never dropped, to fit; `truncated: true` plus a `notice` carries the same marker as other tools, and `ToolResult.truncation` reports `{unit: "characters"}`. Audit: the delegated `web.search` without the query field, `web.fetch` without the URL host, and one `web.read {depth, resultsCount, readCount, failedCount, truncated, duration}`. No query text, URL host or credential reaches the audit.

## Limit and backoff

Up to 3 attempts. `429`, `500`, `502`, `503`, `504` and network errors are retried; `Retry-After` (seconds or HTTP date) wins over the exponential backoff with jitter (500ms..8s). `400` and other errors stop at the first response. The final failure is a redacted tool error.

## Untrusted

Search results are external data. The manifest marks `risk: low`, `permission: read`, `sideEffects: network` and its description warns that the content may contain prompt injection: the model must not execute instructions coming from it.

## `web_fetch`

`{url, maxLength? (50000), format? ("markdown"|"text")}` downloads an `http(s)` URL and returns clean text. `outboundUrlProblem` rejects loopback, private ranges and metadata hosts; every redirect hop (at most 3) is revalidated by literal and by DNS-resolved addresses. HTML removes real tags first and only then decodes entities; every `<` followed by something tag-like is escaped (`&lt;div>`), including inside another fragment or without `>`, so markup encoded with `href`/`onerror` does not become a tag while comparisons such as `a < b` stay intact. `href` is decoded until stable, removing every C0 (tab/LF/CR included) on each pass, before checking a scheme allowlist (`http`/`https`/relative), which closes double/triple-encoded and control characters between entities; `script`/`style`/`iframe`/`object`/`embed`/`noscript`/`svg`/`template`/`base` and handlers are removed; a `script`/`style` block without its closing tag (cap cut) is dropped to EOF, so the cap never returns raw JS/CSS (#57). Titles, lists and links are preserved in markdown. Reading is limited to `maxLength * 4` bytes (1MB ceiling) before the cut; non-text content is rejected, `text/plain` passes through and a missing `Content-Type` is treated as HTML. Audit `web.fetch {url, status, contentLength, duration}` without query/hash.

## Dev opt-in (outbound)

`ASTRO_ALLOW_PRIVATE_URLS=1` (per process and children, dev only) releases loopback, RFC1918, ULA and reserved ranges (`0.0.0.0/8`, multicast) in URLs validated by `outboundUrlProblem`; CGNAT (100.64/10), metadata (ULA `fd00:ec2::/64` and `fd20:ce::/64`, mapped IPv4 and known hosts) and link-local stay blocked. `webSearch.baseUrl` and every `fallback[].baseUrl` use only `urlProblem` (any provider): they accept loopback/RFC1918/ULA; the golden runner validates each declared fallback `baseUrl` (the backend default when absent) and names the failing entry when it is not loopback; a plugin provider `baseUrl` in `astro.config.json` does not pass through `outboundUrlProblem` (pre-existing limit).
