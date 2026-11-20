# Plano do run (`todo_write`)

Resumo: `todo_write` guarda o plano do run em memória, substitui a lista inteira e devolve o plano compacto. A tool não escreve arquivo; uma saída acima do cap pode virar artefato do executor, já redigida.

| Cobre | Não cobre |
|---|---|
| Contrato, validação, estado, disco e auditoria de `todo_write` (F-17, #539) | Painel de tarefas da TUI (T2) e comando `/todos` |

## Contrato

`todo_write({ items: [{ content, status }] })`

- `items` substitui o plano do run; `items: []` limpa.
- `status`: `pending` | `in_progress` | `done`.
- `content`: string não vazia após `trim`, até 200 caracteres; duplicata é comparada no texto trimado **antes** da redação, então duas chaves diferentes não colidem em `[REDACTED]`.
- Máximo de 50 itens.
- Saída: `{ total, pending, in_progress, done, items }` em JSON compacto, para o modelo ver o que falta.
- `content` guardado e devolvido passa por `redactSecrets` e é cortado por code point (nunca parte um par surrogate).

## Onde o estado vive

`TodoPlanStore` (`src/tools/todo-write.ts`): em memória do processo, uma entrada por `ctx.run`.

| Situação | O plano... |
|---|---|
| Turnos da mesma sessão de chat (`runId` reusado) | sobrevive: `AgentSession` injeta o mesmo store em `RunOptions.todoPlans` |
| `astro run`, eval, replay (um run por processo) | vive só até o run terminar |
| Subagente `task` (run próprio `<pai>.task.<uuid>`) | é outro: o filho começa vazio e não altera o plano do pai |
| Subagente `spawn_agent` e run multi-agent | compartilham o `ctx.run` do pai: **o último `todo_write` vence**; o plano não é isolado por agente |
| Processo reiniciado | não existe: o plano nunca é persistido |

O plano é **display-only**: só o próprio modelo o lê (a tool devolve a lista). Nada no runtime — gate, orçamento, conclusão ou handoff — depende dele até o T2 ler.

## O que a tool grava

`todo_write` não abre, cria nem altera arquivo, e não recebe caminho no input: `.astro/`, `protectedPaths` e o confinamento de caminho (I-11) não são tocados pela tool.

Isso não impede um artefato do **executor**: toda tool que devolve mais que o cap efetivo de saída (CMP-10, ADR-0015) tem o resultado completo, já redigido, gravado em `.astro/outputs/<run>/<call>-<hash>.txt`, com cabeçalho + cabeça + cauda no contexto. Um plano grande (perto do teto de 50×200) pode produzir esse arquivo com o texto **redigido** dos itens; audit e ledger continuam só com contagens. `sideEffects: "none"` descreve a tool, não o executor, e por isso permanece.

## Validação

Entrada inválida vira `ToolResult` com `isError: true` e `code: "invalid_input"`, e o plano anterior fica intacto: objeto sem `items`, campo desconhecido, item que não é objeto, `content` vazio, `content` acima do teto, `content` repetido, `status` fora do vocabulário e lista acima de 50 itens. A mensagem cita índice e campo, nunca o texto do item.

## Auditoria e manifesto

- `todo.updated` carrega `{ total, pending, in_progress, done }`: só contagens. O texto é saída do modelo e não vai para o audit (I-03); `tool.call`/`tool.result` continuam sem conteúdo.
- O append do audit acontece **antes** de `store.set`: se o audit falhar (lock fail-closed), o plano anterior permanece e o run não fica com estado sem registro.
- Manifesto: `risk: low`, `permission: read`, `class: read_common`, `sideEffects: none`, `idempotent: true`. `read_common` é a classe de "sem efeito externo" — o vocabulário do gate (PERM-02) não tem classe de estado efêmero do run, e declarar `edit`/`write` faria a tool pedir aprovação de escrita a cada plano sem escrever nada.
- Executa só se `todo_write` estiver em `agent.tools` (I-01); não entra em `DEFAULT_AGENT_TOOLS`.
