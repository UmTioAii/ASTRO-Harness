# Plano do run (`todo_write`)

Resumo: `todo_write` guarda o plano do run em memória, substitui a lista inteira e devolve o plano compacto; não escreve arquivo.

| Cobre | Não cobre |
|---|---|
| Contrato, validação, estado e auditoria de `todo_write` (F-17, #539) | Painel de tarefas da TUI (T2) e comando `/todos` |

## Contrato

`todo_write({ items: [{ content, status }] })`

- `items` substitui o plano do run; `items: []` limpa.
- `status`: `pending` | `in_progress` | `done`.
- `content`: string não vazia após `trim`, até 200 caracteres; conteúdo repetido é recusado.
- Máximo de 50 itens.
- Saída: `{ total, pending, in_progress, done, items }` em JSON compacto, para o modelo ver o que falta.

## Onde o estado vive

`TodoPlanStore` (`src/tools/todo-write.ts`): em memória do processo, uma entrada por `ctx.run`.

| Situação | O plano... |
|---|---|
| Turnos da mesma sessão de chat (`runId` reusado) | sobrevive: `AgentSession` injeta o mesmo store em `RunOptions.todoPlans` |
| `astro run`, eval, replay (um run por processo) | vive só até o run terminar |
| Subagente `task` (run próprio `<pai>.task.<uuid>`) | é outro: o filho começa vazio e não altera o plano do pai |
| Run multi-agent (planner/coder no mesmo `runId`) | é o mesmo: o plano é do run, não do agente |
| Processo reiniciado | não existe: nada vai para o disco |

## Validação

Entrada inválida vira `ToolResult` com `isError: true` e `code: "invalid_input"`, e o plano anterior fica intacto: objeto sem `items`, campo desconhecido, item que não é objeto, `content` vazio, `content` acima do teto, `content` repetido, `status` fora do vocabulário e lista acima de 50 itens. A mensagem cita índice e campo, nunca o texto do item.

## Auditoria e manifesto

- `todo.updated` carrega `{ total, pending, in_progress, done }`: só contagens. O texto é saída do modelo e não vai para o audit (I-03); `tool.call`/`tool.result` continuam sem conteúdo.
- Manifesto: `risk: low`, `permission: read`, `class: read_common`, `sideEffects: none`, `idempotent: true`. `read_common` é a classe de "sem efeito externo" — o vocabulário do gate (PERM-02) não tem classe de estado efêmero do run, e declarar `edit`/`write` faria a tool pedir aprovação de escrita a cada plano sem escrever nada.
- Executa só se `todo_write` estiver em `agent.tools` (I-01); não entra em `DEFAULT_AGENT_TOOLS`.
- Não há caminho no input: nada é lido ou escrito no FS, então `.astro/`/`protectedPaths` e o confinamento de caminho (I-11) não são tocados. Se um dia a tool gravar artefato em `.astro/`, ela passa a seguir as mesmas regras de `write_file` (confinamento e aprovação).
