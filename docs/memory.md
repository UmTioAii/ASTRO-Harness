# Memória (markdown, injetada no início do run)

Resumo: `$ASTRO_HOME/memory.md` (global) e `<cwd>/.astro/memory.md` (project) entram no system prompt sob `## Memory`; a única escrita é `memory_write`, aprovada como `edit` e redigida antes de gravar.

| Cobre | Não cobre |
|---|---|
| Leitura, redação, cap e corte da memória; contrato e confinamento de `memory_write`; `/memory` (#532) | Ranking/embeddings (índice SQLite/FTS), leitura de transcripts, sincronia entre máquinas |

## Arquivos e ordem

| Escopo | Caminho | Vale para |
|---|---|---|
| global | `$ASTRO_HOME/memory.md` (default `~/.astro/memory.md`) | toda pasta do usuário |
| project | `<cwd>/.astro/memory.md` | só a pasta do run |

- Os dois são lidos no início do run; global primeiro, project depois, cada um em um bloco `### Global (<path>)` / `### Project (<path>)` dentro de `## Memory`.
- Arquivo ausente é normal: nenhum bloco, nenhum erro, nenhuma seção.
- Arquivo ilegível (permissão, path é diretório, link que escapa da raiz) avisa uma vez e o run segue sem aquele bloco.
- Formato: markdown; cada `## título` é uma seção. O preâmbulo antes do primeiro `##` também é um bloco.
- A memória é **dado**, nunca instrução executável: não há eval, import ou comando a partir dela.

## Orçamento (`memory.maxChars`)

- Default `8000` caracteres, configurável em `memory.maxChars` (inteiro positivo).
- O budget é compartilhado pelos dois arquivos, na ordem de injeção.
- O corte é na **fronteira de seção**: a seção inteira entra ou fica de fora; o modelo nunca recebe meia seção.
- O prompt inclui o marcador `[... memória truncada: N bytes omitidos ...]` e o conjunto (cabeçalho + blocos + marcador) não passa de `maxChars`.
- O corte audita `memory.truncated` com `{ scope, bytes, maxChars }`: bytes omitidos, nunca conteúdo (I-03).

## Redação (I-03)

- O texto de cada arquivo passa por `redactSecrets` antes de entrar no prompt: chave/token/PEM/JWT na memória vira `[REDACTED]`.
- `memory_write` redige o texto recebido antes de gravar e redige de novo o arquivo existente antes de reescrevê-lo.
- Audit e ledger não recebem o conteúdo: só `{ scope, section, chars }`.

## `memory_write`

`memory_write({ scope, section, text })`

| Campo | Regra |
|---|---|
| `scope` | `project` ou `global`; vocabulário fechado |
| `section` | uma linha, até 60 caracteres; letras/números/espaço/`.`/`-`/`_` |
| `text` | markdown não vazio, até 4000 caracteres |

- Se `## <section>` existe, o corpo é substituído até o próximo `## ` (headings `###` ficam dentro da seção); senão a seção é acrescentada no fim.
- Não aceita `path` no input: o alvo é derivado do `scope`. Mesmo assim passa pelo confinamento (I-11): symlink/junction que sai do cwd (project) ou de `$ASTRO_HOME` (global) é recusado, e `protectedPaths` (ledger/audit) nunca são sobrescritos.
- Manifesto: `class: "edit"`, `permission: "write"`, `risk: "medium"`, `sideEffects: "filesystem"`, `retryable: false`.
- Em `ask` a chamada pede aprovação (`edit`); em `bypass` executa, mas confinamento/redação continuam valendo.
- Erros tipados: `invalid_input` (validação) e `path_denied` (confinamento/protected path).
- Audit `memory.write` com `{ scope, section, chars }`, depois da gravação.
- Só executa se `memory_write` estiver em `agent.tools` (I-01); não entra em `DEFAULT_AGENT_TOOLS`.
- Nada é escrito sem uma chamada explícita: não há aprendizado automático de transcript e o próximo run lê o arquivo atualizado.

## `/memory`

| Comando | Saída |
|---|---|
| `/memory` | blocos injetados, caminho global/project e orçamento (`usados/max`, restante) |
| `/memory path` | só os dois caminhos |

Disponível no REPL e na TUI; usa `memory.maxChars` da config efetiva.

## Testes

`tests/memory.test.ts`: injeção (global antes de project), arquivo ausente, cap/corte com `memory.truncated`, redação, arquivo ilegível, escrita/substituição de seção, audit sem conteúdo, confinamento (`..`/junction e `protectedPaths`), aprovação em `ask`, isolamento entre projetos e `/memory`.
