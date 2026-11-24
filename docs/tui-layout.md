# Layout da TUI

Onde cada informação da TUI vive: header de identidade, footer de números, erro com próximo passo e log sob demanda (#480).

## Princípios

- Uma informação, um lugar. Se o header mostra, o footer não repete.
- Cor tem significado: vermelho é erro ou risco, amarelo é aviso, cinza é estado.
- Silêncio por padrão: nada é reimpresso; o que já foi dito vai para `/log`.

## Antes e depois

| Elemento | Hoje | Depois |
|---|---|---|
| Header | Caixa com versão, provider, modelo, endpoint, estado e modo; pode passar de 80 colunas | Removido (#595): a identidade do estado vazio vem da zona 1 da timeline |
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

## Identidade

O estado vazio mostra o wordmark `ASTRO` da zona 1 da timeline (`renderTimelineZones`, ADR-0035); não há mais linha de header. Versão, provider, endpoint e saúde saem da tela principal: a versão e o endpoint ficam no cabeçalho da sessão em `/log`, e a saúde só aparece lá como transição (#514).

## Footer

Formato: `modelo · pasta · in/out tokens · custo · orçamento · modo`

| Campo | Quando aparece |
|---|---|
| modelo | Sempre; é a única aparição do modelo na tela (#595) |
| pasta | Sempre; `~` para o home |
| tokens | Só quando `in + out > 0` |
| custo | Só quando o preço é conhecido; sem `n/d` |
| orçamento | Só quando há orçamento configurado; vermelho no teto, amarelo no aviso |
| modo | Sempre: `ask`, `auto` ou `bypass` |

- `bypass` sai em vermelho e pinta a borda do input de vermelho; é o único modo com cor.

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
| thinking | caixa com `pensando…` + stream parcial | ctrl+t recolhe/mostra; reasoning ainda sem evento (#635); stream sanitizado (I-03); some no fim do turno |
| tool | `▸ read_file src/a.ts` → `✓`/`✗` com duração | ctrl+o expande o corpo redigido, sempre por `callId` (ADR-0035); recolhido fica em uma linha |
| resposta | Markdown | sanitizada em bloco antes de renderizar (I-03) |

- Durante o turno o editor continua editável; Enter coloca a mensagem na fila (`fila: N` acima do input) e o dreno acontece no fim do turno, na ordem digitada.
- Tab completa; o 1º Enter aplica a completion na linha e o próximo Enter confirma e roda (#471). Linha já exata ao comando destacado roda no 1º Enter; linha com argumento submete direto; completions de `@arquivo` não seguram o Enter.
- O REPL (`astro chat`) fica com linhas planas: fora de escopo desta issue.

## Expansão e aprovação (#635)

- Recolhido por padrão: a entrada de tool fica em uma linha; `ctrl+o` acrescenta o corpo abaixo dela, sem reflow do que está acima.
- `ctrl+t` recolhe o bloco thinking e alterna o corpo de reasoning da timeline (`#600`); quando o provider não emite reasoning não aparece linha nem placeholder (ADR-0035). O corpo expandido passa por `sanitizeBlockText` (ANSI, tabs e segredos) antes da medição de largura (I-03); um OSC não terminado não apaga as linhas seguintes.
- A aprovação ocupa a zona do composer e a pergunta quebra em várias linhas, então o fim de um comando perigoso continua visível em 80 colunas; a resposta digitada e o cursor ficam na linha de baixo. `tab` abre o diff quando existe.
- Cancelar o turno (`ctrl+c`) marca toda entrada `running` como `failed`.

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

- Identidade: o estado vazio é o wordmark da zona 1; nenhuma linha de versão ou saúde aparece na tela principal.
- Footer: nenhum campo do header reaparece (não há header); o modelo aparece uma vez, no footer.
- Avisos: nenhum texto aparece nos dois lugares; o de contexto tem a primeira ocorrência inline e as repetições em `/log`.

## Fora de escopo

- Tema, mouse e novos keybinds.
