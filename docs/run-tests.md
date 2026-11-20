# Comando de teste do projeto (`run_tests`)

Resumo: `run_tests` executa o comando de teste declarado em `run.tests.command` no mesmo sandbox Docker do `run_command`, sem shell; o modelo não escolhe binário, argumento nem flag.

| Cobre | Não cobre |
|---|---|
| Contrato, config, execução, saída, erros e auditoria de `run_tests` (F-15, #538) | Gate de conclusão C5, integração com golden tasks e múltiplos comandos por projeto |

## Config

| Chave | Tipo | Default | Regra |
|---|---|---|---|
| `run.tests.command` | `string[]` (argv) | ausente | Executável + argumentos, um item por argumento. Sem auto-detecção: sem a chave, a tool devolve `tests_not_configured` citando a chave |
| `run.tests.timeoutMs` | inteiro > 0, até `3600000` | `120000` | Teto de execução; o timeout do sandbox usa este valor. Acima de 1h o load falha (`setTimeout` satura e dispararia em ~1 ms) |

`["bun test"]` é recusado no load com mensagem pedindo `["bun", "test"]`: item único com espaço é a string de shell disfarçada de argv. Chave desconhecida em `run.tests` também falha.

```json
"run": { "tests": { "command": ["bun", "test"], "timeoutMs": 120000 } }
```

## Contrato

`run_tests({ filter? })`

- Sem argumentos, executa exatamente `run.tests.command`.
- `filter` (até 200 caracteres) é **um** item de argv anexado ao fim; nunca concatenado nem interpretado. Vazio, com caractere de controle (`\n`, `\0` — checado no valor cru, antes do `trim`) ou começando com `-` é `invalid_input` — flag não vem do modelo.
- Campo desconhecido no input é `invalid_input`: o comando só vem da config.

## Execução

| Aspecto | Comportamento |
|---|---|
| Sandbox | Sempre Docker, regra própria do `run_tests` (#474): o host default do `run_command` não vale aqui. `docker run` efêmero, `--network none`, rootfs read-only, máscaras `:ro` de `.git`/hard-block, cwd bindado |
| Shell | Nenhum: o argv configurado vira o `cmd` do container, item a item (`dockerArgvNoShell`) |
| `sandbox: false` | Recusa `sandbox_required_for_shell` sem tocar o host (I-19), igual ao `run_command` |
| `sandbox` ausente/`"auto"` (host) | Recusa `sandbox_required_for_shell` citando `run_tests` e Docker; o host do ADR-0031 vale só para `run_command` |
| `sandbox: true`/`"docker"` | Habilita o caminho Docker; sem daemon a recusa é explícita, sem downgrade para o host |
| Env | Host não entra no container (env mínima do docker CLI), como no `run_command` (I-03) |

## Saída

JSON compacto: `{ command, exitCode, durationMs, truncated, output }`, mais `timedOut: true` ou `cancelled: true` quando for o caso. Cada item de `command` passa por `redactSecrets`, igual ao audit.

| Caso | Resultado |
|---|---|
| Exit 0 | `isError` ausente; saída até o cap pela **cabeça** |
| Exit != 0 | `isError: true` com o código e a saída até o cap pela **cauda** (onde mora o relatório) |
| Timeout | `isError: true`, `exitCode: null`, `timedOut: true`; container removido |
| Cancelado | `isError: true`, `exitCode: null`, `cancelled: true`; container removido. **Via executor** a tool nem entrega esse JSON: o `AbortSignal` do executor vence a corrida e o modelo recebe `cancelado: a tool "run_tests" foi interrompida` |
| Acima do cap | `truncated: true`; o teto `MAX_OUTPUT` (10 000 caracteres) vale para o **JSON inteiro**, o mesmo do `run_command` |

Caractere de controle escapa para 2–6 caracteres no JSON; por isso o envelope é medido já serializado e cortado por code point (nunca fatiando a string JSON, que viraria JSON inválido). A saída passa por `redactSecrets` **antes** de qualquer corte (ADR-0027, I-03).

## Aprovação e auditoria

- Manifesto: `class: "shell"`, `permission: "execute"`, `sideEffects: "process"`, `retryable: false`, `idempotent: false`. A classe é `shell` porque executa um processo do projeto: a matriz (PERM-01) pede aprovação em `ask` e `allow-edits` e libera em `bypass`; perfil de agente `read-only`/`write` é negado antes da execução.
- Prompt: a tool implementa `Tool.approvalDetail` e entrega o comando da config (com o `filter`, quando válido) como detalhe material; o executor normaliza (uma linha, redigido, até 200 caracteres). Sem essa seção, o prompt diria só `run_tests`.
- Executa só com `run_tests` em `agent.tools` (I-01); não entra em `DEFAULT_AGENT_TOOLS`.
- Audit: evento `tests.result` com `{ command, exitCode, durationMs, truncated, isError }` — comando redigido e **nunca** a saída dos testes. `tool.call`/`tool.result` continuam sem conteúdo.
- Cenário de eval (`src/eval/scenario.ts`) recusa `run_tests` na allowlist e `run.tests` na config: o golden é hermético e não declara comando de teste do projeto.
