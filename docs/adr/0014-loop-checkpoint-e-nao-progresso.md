# ADR-0014: loop de segmento com checkpoint e guarda de não-progresso

- Status: aceita
- Data: 2026-10-28
- Issue: #120, #450
- Decisões relacionadas: D-12, ADR-0010, ADR-0013

## Contexto

`maxSteps` existe (`src/session.ts`); F-06 (S-10) dá cancelamento e F-22 (S-14) resume determinístico. Falta o loop de segmento com presets, checkpoint e guarda de não-progresso (L1–L7) para runs longos sob budget.

## Decisão

**Presets (L1).** Config `run {checkpointAt: 0.8, noProgressSegments: 3, judge: "off"}`; o limite de trabalho é `agent.maxSteps`, contado em passos por tarefa/agente. `run.maxTurns` foi removido (P4): turno é unidade de interação, não de limite.

**Passo (L3).** Um passo = uma chamada de modelo + as tool calls que ela pede; completion sem tool calls encerra o loop, salvo quando o juiz (L4) devolve `continue` — aí o run segue por mais um passo, limitado por `maxSteps` e pelo teto físico (B10).

**Checkpoint (L5).** A 80% do limite de passos OU do gasto do escopo do budget (D-27), grava `{summary, changed files, next step}` sanitizado (I-03) no store do ADR-0010 (PS-2). Bater o limite para em estado seguro (I-19, via S-10); retomar o run pelo ledger é replay determinístico com `astro resume <run> --task <...>`; retomar do checkpoint é `astro continue <run> [--task] [--agent]` (run novo, D-27), com os limites da config (S-14). Subir budget em runtime com aprovação foi entregue em D-30 (#372/#388): `budget.raised` no ledger, teto físico exige `CONFIRMAR`; sem TTY ou `onExceed: stop` continua a parada segura. O B4 decide depois do estouro: `continue_same`/`lower_effort`/`stop` no chat/TUI e mais `raise` (D-30) na CLI. O prompt de não-progresso (`onNoProgress`) é o ponto de "continuar" em runtime.

**Escopo multi-agent (L5/L6).** No loop multi-agent cada agente ativo grava o próprio checkpoint, uma vez, na fração do limite dele (passos do agente) ou do gasto do escopo, depois das tools do passo; o não-progresso é contado por agente, inclusive no passo que faz handoff. A gravação é best-effort: falha de I/O/encoding vira audit `loop.checkpoint_error` com `{step, code}` (sem path nem conteúdo) e o run continua — não queima o handoff já recebido. O filho do `task` recebe o mesmo `config.run` e o decider do pai. Nome de agente/run com `_` ou `.` vira segmento reversível do path (`x_` + base64url); nome que não pode virar segmento (separador, `..`, controle/formatação ou >120 caracteres) é recusado no load da config.

**Não-progresso (L6).** Sinais por segmento: hash dos caminhos tocados pelas tools + número de falhas de tool (um teste que falha vira erro de tool). O tamanho do histórico não entra no hash porque cresce a cada passo e mascararia o loop. 3 segmentos sem mudança → pausa e pergunta.

**Judge (L4, #450).** `run.judge` aceita `off` (default), `on` e `auto`. Antes de declarar sucesso, o juiz recebe só o objetivo e a última saída do assistente (limitados, redigidos e com `<`/`>` escapados, I-03) e devolve `{"verdict":"done|continue|stop","reason":"..."}` por uma chamada única ao provider existente (`purpose: "cheap"`, sem tools). `on` julga toda completion; `auto` só com sinal: primeira completion, checkpoint gravado, não-progresso retomado ou `continue` anterior — nunca todo turno. `done` segue o sucesso; `continue` injeta o motivo redigido e volta ao loop, limitado por `maxSteps` e pelo teto físico (B10), não por `noProgressSegments`; sem turno disponível para em `judge_continue_exhausted` (I-19). `stop` para em ponto seguro (`judge_stop`, I-19). Sem retry: saída malformada ou erro de provider voltam ao caminho normal, e budget, quota ou limite de time esgotados não fazem a chamada extra; o uso do juiz entra no ledger e um cruzamento do teto físico encerra em `budget_exceeded` com `budget.ceiling_hit` (B10/I-17). O audit guarda `judge.verdict {step, verdict, reasonHash}`, `judge.failed {reason}` e `judge.skipped {reason}`, nunca prompt nem saída (I-03/I-04); `reasonHash` cobre o mesmo motivo sanitizado que o loop recebe. O multi-agent não implementa o estágio e audita `judge.skipped {reason: "unsupported"}`; o filho do `task` herda `run.judge`.

**Paradas físicas (L7).** O loop para por: conclusão, teto físico (`ceiling_hit`, ADR-0013) ou não-progresso — nunca roda sem parada física (golden §11.8).

## Consequências

- Ganho: runs longos supervisionados, com estado seguro e retomável; sem loop infinito sem corte.
- Custo: S-18 (#135) implementa; apresentação no REPL/TUI fica em T1/T2. Com `judge` diferente de `off`, uma chamada extra por completion julgada, auditada só pelo hash do motivo (#450).
- Invariantes afetadas: I-19 (estado seguro e retomável), I-03 (checkpoint sanitizado).

## Alternativas descartadas

- Sem checkpoint: trabalho longo perdido no esgotamento do limite.
- Judge `on` por default: custo extra e não determinismo — v2.
- Parar apenas em `maxSteps`: deixa o loop sem corte quando não há progresso.
