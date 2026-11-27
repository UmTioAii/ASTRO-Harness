# ADR-0015: compactação de sessão, limites de saída e contagem de tokens por provider

- Status: aceita
- Data: 2026-10-28
- Issue: #120
- Decisões relacionadas: D-10, D-22, ADR-0010, ADR-0014

## Contexto

Janelas de contexto são finitas. A parte de compactação de F-08 (CMP-1..12) precisa de artefato próprio — `HandoffArtifactV1` carrega só `compaction?`/`truncated`/contagens — e depende de contagem de tokens por provider, que precisa de ID novo: D-18 é a taxonomia de erros (Q-06 veta o reuso).

## Decisão

**Gatilho e parte recente (CMP-1, CMP-2).** Compacta quando a estimativa atinge `window − reserve`; sem `buffer`, reserve = max(15% da janela, 16.000); buffer explícito substitui o default e é ignorado se ≥ janela. A parte recente tem 15.000 tokens de mensagens, sem system prompt nem `AGENTS.md`, cortada no início de mensagem de usuário; quando há turno anterior, o último usuário é preservado (bounded por uma mensagem). Num run de uma tarefa só após tools, o corte vai para o assistant dono do par tool call/result — nunca no meio do par. O `Active` do artefato é o começo da última mensagem de usuário, clipado em 500 chars; nos níveis 3–4 o resumo recebe o começo do texto (4.000 chars). Contada pelo tokenizer do modelo ativo, senão 4 chars/token marcado estimate; a janela encurta a parte recente para caber system + artefato + reserva, e contexto já acima da janela compacta mesmo sem projetar abaixo do gatilho.

**Integridade e artefato (CMP-3, CMP-4, CMP-5).** Nunca compacta no meio do par tool call/result. `CompactionArtifactV1` (`src/compaction/types.ts`) com seções Active, Blocked, Next Move, Relevant Files (máx 15), Important Context; campos compartilhados com handoff são copiados; o pedido de resumo não chama tools. Redução em 5 níveis: full → outputs clipados (2.000 head + 2.000 tail) → outputs removidos e inputs clipados → só texto do usuário clipado → omitido.

**Breaker and retry (CMP-6, CMP-7).** The breaker gates only the model summary. Three consecutive summary failures pause the model for 5 min (`compaction.paused` in the audit); while paused, compaction still runs through the model-free extractive path (`deterministicSummary`, audited as `compaction.degraded`), so a paused breaker never interrupts the run. `/compact force` still resets the counter and records `compaction.manual`; the counter lives in the ledger (`compaction.failure_count`) and survives `--resume`. Only transient summary errors (`transient_rate_limit`, `outage`, `network_timeout` — D-18) are retried, with an abortable exponential backoff (`compaction.maxRetries`, `compaction.retryBackoffMs`); a deterministic error (invalid model, auth, oversized request, raw `TypeError`) goes straight to the extractive path and is audited as `unclassified`. Provider size rejection → compact and retry once; second rejection → error; when the extractive fallback cannot reduce the context, the provider's own rejection surfaces. `AGENTS.md` returns to the context after compaction (CMP-8).

**Background (CMP-9, #449).** After a step that will still call the provider, compaction is scheduled on a depth-1 queue (`src/compaction/background.ts`) and the next completion consumes the ready artifact without summarizing inline. It prewarms once per 2k-token growth; `take()` aborts the in-flight job before matching prefix/identity — including when it consumes a valid artifact from disk — so no summary is paid twice. The result is written atomically (tmp+rename) with a readiness marker and provider/model/window/buffer identity; a partial artifact, another turn, another model or a failure fall back to synchronous compaction. A background failure is audited once per snapshot and never records a compaction ledger entry or increments the breaker counter; it never rejects the turn, and the inline path decides. A ready artifact summarized before a breaker pause is not consumed while the breaker is paused nor after the pause expires without a fresh model probe, so it never clears the breaker counter. The run waits for the in-flight job on shutdown, deletes the unconsumed artifact and sweeps `*.tmp`. The ceiling is re-evaluated after the drain without overwriting an already recorded terminal error. `/compact force` and the `CompactionArtifactV1` schema do not change; the audit gains `compaction.degraded` (extractive fallback) and `compaction.paused` (breaker opened).

**Limites de saída (CMP-10..12).** Cap por saída = min(8000 tokens, 5% da janela); excedente vira arquivo com head, tail e referência de fonte (path/URL/tool-call id; irrecuperável → `truncated_unrecoverable`). `read_file` pagina 350 linhas com overlap 10; `grep` ganha `page` com `{results, total, page, hasMore}`.

**Contagem por provider (Q-06).** A contagem ganha o ID novo **D-22** em `docs/decisions.md`: pura, determinística, sem chamadas a provider e sem segredo (I-03); tokenizer nativo quando existir, estimativa 4 chars/token marcada; nunca reporta zero quando desconhecida. A linha de D-22 na tabela e o ajuste de `roadmap-complementar` ficam no PR de S-19 (#136).

**Implementação (S-17, #134).** `src/compaction/` implementa gatilho/reserva, parte recente, níveis 1–5, artefato (`types.ts`), breaker no ledger (`breaker.ts`) e o runtime que compacta antes da chamada e retenta uma vez por overflow (`runtime.ts`). Janela que não comporta a reserva (ex.: 8k com default 16k) não compacta. `/compact force` grava `compaction.manual` e zera o contador.

**Ledger.** Este ADR é dono do kind `compaction`: `failure_count`, `manual` (schema em #122).

## Consequências

- Ganho: sessões longas cabem na janela com corte previsível e breaker persistente.
- Custo: S-17 (#134) compacta, S-16 (#133) limita saídas, S-19 (#136) conta; config ganha `outputLimit`.
- Invariantes afetadas: I-03 (artefato e saídas sanitizados), I-19 (breaker sobrevive ao resume).

## Alternativas descartadas

- Reusar `HandoffArtifactV1`: não tem as seções de compaction; carrega campos de handoff.
- Contagem como parte de D-18: Q-06 veta — taxonomia de erros ≠ contagem de tokens.
- Compactar no meio do par tool call/result: perde o resultado em voo.
