# Layout da TUI

Onde cada informação da TUI vive: header de identidade, footer de números, erro com próximo passo e log sob demanda (#480).

## Princípios

- Uma informação, um lugar. Se o header mostra, o footer não repete.
- Cor tem significado: vermelho é erro ou risco, amarelo é aviso, cinza é estado.
- Silêncio por padrão: nada é reimpresso; o que já foi dito vai para `/log`.

## Antes e depois

| Elemento | Hoje | Depois |
|---|---|---|
| Header | Caixa com versão, provider, modelo, endpoint, estado e modo; pode passar de 80 colunas | Uma linha sem caixa: versão, provider/modelo e saúde |
| Footer | Repete provider, modelo, saúde e modo; mostra contadores e custo quando há | Só campos com valor; modo sempre; bypass em vermelho |
| Erro | Linha vermelha sem saída + toast com o mesmo texto | Linha vermelha com próximo passo, uma vez, sem toast |
| Estado | Aviso reimpresso a cada turno e às vezes em toast | Uma linha cinza, uma vez por sessão |
| Progresso | `pensando…`, sem contador | `pensando…` em bloco, recolhível com ctrl+t (#560); contadores só em `/usage`, `/config` e relatório (#594) |
| Shell `!cmd` | saída como linha de info/erro | bloco com borda: `$ cmd · cwd: … · exit: 0\|erro` + saída (#560) |
| Entrada durante o turno | descartada | fila (`fila: N`), enviada ao fim do turno (#560) |
| Enter com menu aberto | submete o prefixo digitado | 1º Enter aplica a completion, 2º Enter roda (#471, #560) |
| Status do turno | Entrada `[modelo] N step(s) · tokens · total` na conversa + toast | Só em `/log`, sem contador de rodada (#594) |
| Endpoint | No header, competindo com modelo | `/log`, no cabeçalho da sessão |
| Modo | No header e no footer | Só no footer; bypass também pinta a borda do input |

## Header

Formato: `ASTRO v<versão> · <provider>/<modelo> · <saúde>`

| Caso | Linha | Colunas |
|---|---|---|
| Par mais longo do catálogo: `nvidia/meta/llama-3.3-70b-instruct` | `ASTRO v0.1.0-alpha.4 · nvidia/meta/llama-3.3-70b-instruct · ok` | 62 |
| Limite sintético: provider `openai-compatible` (sem modelos) com o modelo mais longo | `ASTRO v0.1.0-alpha.4 · openai-compatible/meta/llama-3.3-70b-instruct · ok` | 73 |
| O mesmo, sem check | `… · n/d` | 74 |
| O mesmo, provider fora | `… · down` | 75 |

- Teto de 80 colunas. Versão, provider, modelo e saúde são os únicos campos.
- Acima de 80, o modelo é cortado no meio com `…` até sobrar 8 colunas para ele; se ainda passar, o provider é cortado no meio. A saúde nunca é cortada e a linha nunca quebra.
- Um id de provider pode chegar a 64 colunas (limite do slug); é por isso que o corte do provider existe, mesmo sem caso no catálogo.
- Saúde é `ok`, `n/d` ou `down`; `down` em vermelho, `n/d` em cinza.
- Endpoint sai do header e aparece no cabeçalho da sessão em `/log`: é dado de diagnóstico, não de estado. A versão fica porque é o primeiro dado de um bug report.
- A borda da caixa sai; a cor do texto segue a saúde.

## Footer

Formato: `pasta · in/out tokens · custo · orçamento · modo`

| Campo | Quando aparece |
|---|---|
| pasta | Sempre; `~` para o home |
| tokens | Só quando `in + out > 0` |
| custo | Só quando o preço é conhecido; sem `n/d` |
| orçamento | Só quando há orçamento configurado; vermelho no teto, amarelo no aviso |
| modo | Sempre: `ask`, `auto` ou `bypass` |

- `bypass` sai em vermelho e pinta a borda do input de vermelho; é o único modo com cor.
- Nenhum campo do header reaparece aqui.

## Erro

Formato: `erro: <mensagem> · <próximo passo>`, em vermelho, uma vez, na ordem em que aconteceu.

| Classe | Próximo passo |
|---|---|
| `auth` | `revise a credencial com /provider` (ou `defina <VAR> no ambiente`) |
| `hard_quota` | `troque de modelo com /model` |
| `transient_rate_limit` | `aguarde e repita; o retry já tentou` |
| `network_timeout` | `repita; se persistir, aumente providers.<nome>.timeoutMs` (#475) |
| `outage` | `repita ou troque com /model` |
| `invalid_request` | `ajuste o pedido; /help lista os comandos` |
| configuração inválida | `rode astro doctor` |
| tool negada | `ajuste permissions.tools ou aprove a chamada` |
| sem provider | `configure com /provider` |

- Mensagem continua redigida (I-03); o próximo passo nunca repete segredo nem URL com chave.
- Erro fatal encerra a sessão depois de imprimir a linha; não vira toast.

## Estado

- Uma linha cinza, uma vez por sessão: provider ativado, modelo trocado, sessão retomada.
- Texto idêntico não se repete na mesma sessão.
- Aviso que muda a resposta (contexto ≥80%) fica amarelo, inline, uma vez; as repetições vão para `/log`.

## Progresso

- A conversa nunca mostra contador de turno, rodada ou ferramenta (#594). Enquanto o turno roda, o bloco mostra `pensando…`; números de progresso vivem em `/usage`, `/config` e no relatório.
- O bloco some quando o turno termina (sucesso, erro ou abort), porque o progresso só renderiza com turno em andamento.
- Nenhum número é inventado: sem sinal de progresso, fica só `pensando…`.

## Blocos e fila (#560)

| Bloco | Render | Notas |
|---|---|---|
| usuário | `> texto` | inalterado |
| shell `!cmd` | caixa com `$ cmd · cwd: … · exit: 0\|erro`, saída no corpo | `exit` é `0`/`erro` porque o contrato `ToolResult` não traz código numérico |
| thinking | caixa com `pensando…` + stream parcial | ctrl+t recolhe/mostra; some no fim do turno |
| resposta | Markdown | inalterado |

- Durante o turno o editor continua editável; Enter coloca a mensagem na fila (`fila: N` acima do input) e o dreno acontece no fim do turno, na ordem digitada.
- Tab completa; o 1º Enter aplica a completion na linha e o próximo Enter confirma e roda (#471). Linha já exata ao comando destacado roda no 1º Enter; linha com argumento submete direto; completions de `@arquivo` não seguram o Enter.
- O REPL (`astro chat`) fica com linhas planas: fora de escopo desta issue.

## /log

| Move para `/log` | Fica inline |
|---|---|
| Cabeçalho da sessão: versão, provider, modelo e endpoint | mensagens do usuário e do assistente |
| `turno concluído` | erro com próximo passo |
| Linha `[modelo] tokens · total` por turno | pergunta de aprovação e diff |
| Transições de saúde do provider | `pensando…` (sem contador) |
| Avisos de orçamento repetidos | aviso de contexto, uma vez |
| Repetições do aviso de contexto | |
| Detalhe de tool: nome, duração, custo | |

- `/log` abre a tela com o buffer da sessão; `/log <n>` mostra as últimas `n` linhas.
- Cada linha do buffer carrega a lane no prefixo — `[sessão]`, `[turno]`, `[saúde]`, `[aviso]` (#560) — e a sanitização (I-03) continua no `appendLog`.
- O buffer é de memória: a fonte durável continua sendo audit/ledger.
- `AgentSession.send` expõe o observador de turno (#600) com `round.start`, `tool.start`, `tool.end` e `turn.end`; a timeline da TUI consome esses eventos ao vivo (#635), e o buffer de `/log` continua sem consumi-los. `onStep` saiu: o progresso não expõe contador.
- Implementação (#514): buffer ring em `src/tui/log.ts` (`LOG_CAP = 1000`, linhas sanitizadas com `redactSecrets` + controle), tela em `src/tui/log-screen.tsx`, comando em `src/tui/commands.ts` (`openLog`) ligado em `src/tui/app.tsx`. Cabeçalho da sessão (com endpoint), resumo por turno, transições de saúde e avisos repetidos de orçamento/contexto são anexados ao buffer com `laneLine` (#560); no REPL `/log` avisa que é só da TUI.

## Estados removidos

- Endpoint no header.
- Provider, modelo, saúde e modo repetidos no footer.
- Toast de turno concluído.
- Toast de erro duplicando a linha de erro.
- Linha de status por turno na área de conversa.
- `pensando…` coexistindo com toast de conclusão.
- Contador de passo/rodada na conversa (`passo n/max`); contadores vivem em `/usage`, `/config` e no relatório (#594).

## Como verificar

- Header: a tabela acima é o teste; 62 no par real mais longo do catálogo e 73 no limite sintético, ambos abaixo de 80.
- Footer: nenhum campo do header aparece nele.
- Avisos: nenhum texto aparece nos dois lugares; o de contexto tem a primeira ocorrência inline e as repetições em `/log`.

## Fora de escopo

- Tema, mouse e novos keybinds.
