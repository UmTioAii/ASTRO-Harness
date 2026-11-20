# Comando de teste do projeto (`run_tests`)

Resumo: `run_tests` executa o comando de teste declarado em `run.tests.command` no mesmo sandbox Docker do `run_command`, sem shell; o modelo não escolhe binário, argumento nem flag.

| Cobre | Não cobre |
|---|---|
| Contrato, config, execução, saída, erros e auditoria de `run_tests` (F-15, #538) | Gate de conclusão C5, integração com golden tasks e múltiplos comandos por projeto |

## Config

| Chave | Tipo | Default | Regra |
|---|---|---|---|
| `run.tests.command` | `string[]` (argv) | ausente | Executável + argumentos, um item por argumento. Sem auto-detecção: sem a chave, a tool devolve `tests_not_configured` citando a chave |
| `run.tests.timeoutMs` | inteiro > 0 | `120000` | Teto de execução; o timeout do sandbox usa este valor |

`["bun test"]` é recusado no load com mensagem pedindo `["bun", "test"]`: item único com espaço é a string de shell disfarçada de argv. Chave desconhecida em `run.tests` também falha.

```json
"run": { "tests": { "command": ["bun", "test"], "timeoutMs": 120000 } }
```

## Contrato

`run_tests({ filter? })`

- Sem argumentos, executa exatamente `run.tests.command`.
- `filter` (até 200 caracteres) é **um** item de argv anexado ao fim; nunca concatenado nem interpretado. Vazio, com caractere de controle ou começando com `-` é `invalid_input` — flag não vem do modelo.
- Campo desconhecido no input é `invalid_input`: o comando só vem da config.

## Execução

| Aspecto | Comportamento |
|---|---|
| Sandbox | Mesmo caminho do `run_command` (ADR-0027): `docker run` efêmero, `--network none`, rootfs read-only, máscaras `:ro` de `.git`/hard-block, cwd bindado |
| Shell | Nenhum: o argv configurado vira o `cmd` do container, item a item (`dockerArgvNoShell`) |
| `sandbox: false` | Recusa `sandbox_required_for_shell` sem tocar o host (I-19), igual ao `run_command` |
| Sem Docker | Recusa explícita, sem downgrade para o host |
| Env | Host não entra no container (env mínima do docker CLI), como no `run_command` (I-03) |

## Saída

JSON compacto: `{ command, exitCode, durationMs, truncated, output }`, mais `timedOut: true` ou `cancelled: true` quando for o caso.

| Caso | Resultado |
|---|---|
| Exit 0 | `isError` ausente; saída até o cap pela **cabeça** |
| Exit != 0 | `isError: true` com o código e a saída até o cap pela **cauda** (onde mora o relatório) |
| Timeout | `isError: true`, `exitCode: null`, `timedOut: true`; container removido |
| Acima do cap | `truncated: true`; cap `MAX_OUTPUT` (10 000 caracteres), o mesmo do `run_command` |

A saída passa por `redactSecrets` **antes** do corte (ADR-0027, I-03).

## Aprovação e auditoria

- Manifesto: `class: "shell"`, `permission: "execute"`, `sideEffects: "process"`, `retryable: false`, `idempotent: false`. A classe é `shell` porque executa um processo do projeto: a matriz (PERM-01) pede aprovação em `ask` e `allow-edits` e libera em `bypass`; perfil de agente `read-only`/`write` é negado antes da execução.
- No prompt de aprovação o argumento material é o `filter` (quando houver); o comando executado é o de `run.tests.command` e nunca chega pelo input.
- Executa só com `run_tests` em `agent.tools` (I-01); não entra em `DEFAULT_AGENT_TOOLS`.
- Audit: evento `tests.result` com `{ command, exitCode, durationMs, truncated, isError }` — comando redigido e **nunca** a saída dos testes. `tool.call`/`tool.result` continuam sem conteúdo.
