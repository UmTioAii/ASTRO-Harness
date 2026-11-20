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
- `## ` dentro de code fence (``` ou ~~~) não é seção: o mesmo splitter fence-aware vale para o loader, para o fim de corpo em `memory_write` e para validar o texto novo.
- A memória é **dado**, nunca instrução executável: não há eval, import ou comando a partir dela.

## Orçamento (`memory.maxChars`)

- Default `8000` caracteres; `memory.maxChars` aceita inteiro `>= 200` (o piso garante que o marcador de corte caiba inteiro).
- O budget é compartilhado pelos dois arquivos, na ordem de injeção.
- O corte é na **fronteira de seção**: a seção inteira entra ou fica de fora; o modelo nunca recebe meia seção nem meio code fence.
- O prompt inclui o marcador `[... memória truncada: N bytes omitidos ...]` e o conjunto (cabeçalho + blocos + marcador) não passa de `maxChars`.
- O corte audita `memory.truncated` com `{ scope, bytes, maxChars }`: bytes omitidos, nunca conteúdo (I-03).

## Redação (I-03)

- O texto de cada arquivo passa por `redactSecrets` antes de entrar no prompt: chave/token/PEM/JWT na memória vira `[REDACTED]`.
- `memory_write` redige o texto recebido antes de gravar; o conteúdo já em disco não passa por redação de novo (seções intocadas ficam byte a byte).
- Audit e ledger não recebem o conteúdo: só `{ scope, section, chars }`.

## `memory_write`

`memory_write({ scope, section, text })`

| Campo | Regra |
|---|---|
| `scope` | `project` ou `global`; vocabulário fechado |
| `section` | uma linha, até 60 caracteres; letras/números/espaço/`.`/`-`/`_` |
| `text` | markdown não vazio, até 4000 caracteres; sem `## ` de nível 2 fora de fence |

- Se `## <section>` existe, o corpo é substituído até o próximo `## ` (headings `###` ficam dentro da seção); senão a seção é acrescentada no fim.
- Seções duplicadas com o mesmo título são fundidas numa só, na posição da primeira.
- Só o `text` recebido é redigido; o que já está no disco é copiado byte a byte (substituir uma seção não altera as outras).
- Gravação atômica (tmp no mesmo diretório + rename) e backup `<arquivo>.<timestamp>.bak` antes de trocar, como o `edit` (I-16). A saída informa o delta de caracteres do arquivo.
- No escopo global, `$ASTRO_HOME` é criado com `0700` (melhor esforço fora do Windows), como o cofre.
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
`/memory` relê o arquivo na hora: mostra o estado **vivo** do disco. No chat/TUI o system prompt foi montado no início da sessão, então uma escrita só aparece no prompt no próximo run/sessão (a sessão em andamento não é reescrita).

## Agents nomeados

`agents.<nome>.systemPrompt` substitui o prompt base, mas a seção `## Memory` é anexada ao override: um agente nomeado nunca fica sem a memória do run.
Quando `memory_write` não está em `agent.tools`, a linha que ensina a tool é omitida do prompt (não se ensina uma chamada que a allowlist vai negar).

## Testes

`tests/memory.test.ts`: injeção (global antes de project), arquivo ausente, cap/corte com `memory.truncated`, redação, arquivo ilegível, escrita/substituição de seção (byte a byte nas intocadas), `.bak`/atomicidade/delta, seções duplicadas, fence com `## ` dentro, cap que não corta fence, validação de heading no texto, piso de 200, hint sem allowlist, audit sem conteúdo, confinamento (`..`/junction e `protectedPaths`), aprovação em `ask`, isolamento entre projetos, `/memory` e override de agent nomeado.
