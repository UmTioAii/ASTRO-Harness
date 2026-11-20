# ADR-0030: presets Simple/Control e a fronteira entre `profile` e `preset`

- Status: aceita
- Data: 2026-11-20
- Issue: #478
- Decisões relacionadas: D-07, D-24, D-28, D-31, ADR-0007, ADR-0014, ADR-0029

## Contexto

`profile` e `preset` nomeavam coisas diferentes sem fronteira registrada: o ADR-0007 usa `profile` para o pool declarativo de modelos por agent, e `preset` entrou em #515 para a forma da config sem ADR próprio. Sem essa fronteira, "perfil" também é lido como o perfil de provider (D-21) e como o perfil de chamada (ADR-0012), e o limite de trabalho foi unificado: `run.maxTurns` foi removido e `agent.maxSteps` passou a ser o único limite (#545).

## Decisão

`preset` é a forma da config: `simple` ou `control` (`src/core/config.ts`). `simple` fixa o teto do limite de trabalho em 500 passos por tarefa (#515) e recusa `agent.maxSteps` ou `agents.<nome>.maxSteps` acima disso, mantendo valores menores vindos de outra camada; `control` expõe `agent.maxSteps`, `agents.<nome>.maxSteps`, `agents.maxActive`, `spawn.maxActive`, `team.sessionBudgetUsd` e `team.weekBudgetUsd` (#552). O default é `control` (`DEFAULT_PRESET`); sem `agent.maxSteps`, os dois presets começam em 500 (`BASELINE_MAX_STEPS`). `preset` desconhecido falha, não cai no default.

`profile` é a entrada do `modelPool` (ADR-0007): escolhe o modelo, as `capabilities` exigidas e o `fallback` por agent. Regra de uma linha: **`profile` escolhe o modelo; `preset` escolhe o formato da config.**

Defaults e dono de cada ajuste. O preset só decide o limite de trabalho e os knobs exclusivos do `control`; o resto tem dono próprio (D-24, I-17):

| Ajuste | `simple` | `control` |
|---|---|---|
| `agent.maxSteps` | teto 500 (#515) | declarado; 500 quando omitido |
| `permissions.mode` | `ask` (default, fora do preset) | `ask` (default, fora do preset) |
| limite de turnos | não existe | não existe |
| `budget` | ausente = sem camada | ausente = sem camada |

O preset não altera a superfície de tools (D-07) nem o perfil de permissão do agent (D-28): decide só limites.

Turno não é limite: `run.maxTurns` não existe (#545, ADR-0014); turno é a unidade de interação da interface e do `/usage`, e o trabalho é limitado por `agent.maxSteps`.

No `/config`, `simple` deixa os knobs de controle read-only (`agent.maxSteps`, `team.sessionBudgetUsd` e `team.weekBudgetUsd`): a gravação é recusada com a instrução de usar `"preset": "control"` (`src/core/config-edit.ts`, D-31). O teto global de passos continua valendo e o projeto só estreita (ADR-0029). `team.sessionBudgetUsd` e `team.weekBudgetUsd` declarados em qualquer camada exigem `control`: com `simple`, o valor mesclado falha no load. Um `agent.maxSteps` global acima de 500 também falha em `simple`; o projeto reafirma um valor de até 500 ou usa `control`. `permissions.mode` segue editável nos dois presets.

## Consequências

- Ganho: um nome por conceito e um dono por knob; o projeto reduz o teto, mas não amplia a política global (ADR-0029).
- Custo: `simple` não sobe o teto; acima de 500 exige `control` no projeto e o teto declarado na camada global, porque o projeto só estreita (ADR-0029).
- Follow-up de vocabulário, sem mudança de código: `docs/providers.md` e `docs/config-parity.md` chamam de "perfil" a entrada do store de provider (D-21) e o ADR-0012 chama de "call profile" o esforço/thinking do modelo. São conceitos distintos do `profile` do pool; os nomes ficam, a distinção passa a ser esta.
- Invariantes afetados: nenhum. O preset só decide o teto de passos; não toca a allowlist (I-01), o confinamento de caminho (I-11), o custo (I-17), o modo/aprovação (D-24) nem o perfil de permissão do agent (D-28).

## Alternativas descartadas

- Knob `mode` separado de `preset`: dois nomes para a mesma escolha e precedência ambígua.
- `preset` com limite de turnos: turno não é orçamento de trabalho (#545); reintroduz a ambiguidade removida.
- `permissions.mode` variando por preset: o modo é decisão de risco do usuário (D-24, D-28), não atalho de preset.
- Preset inferido do formato da config: silencioso; explícito falha cedo em valor inválido.
