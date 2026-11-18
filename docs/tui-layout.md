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
| Footer | Repete provider, modelo, saúde e modo; mostra `0 turno(s)`, `0/0 tokens`, `n/d` e orçamento ausente | Só campos com valor; modo sempre; bypass em vermelho |
| Erro | Linha vermelha sem saída + toast com o mesmo texto | Linha vermelha com próximo passo, uma vez, sem toast |
| Estado | Aviso reimpresso a cada turno e às vezes em toast | Uma linha cinza, uma vez por sessão |
| Progresso | `pensando…`, sem passo | `pensando… passo n/max` |
| Status do turno | Entrada `[modelo] N step(s) · tokens · total` na conversa + toast | Só em `/log`; o footer já tem os números |
| Endpoint | No header, competindo com modelo | `/status` e `/log` |
| Modo | No header e no footer | Só no footer; bypass também pinta a borda do input |

## Header

Formato: `ASTRO v<versão> · <provider>/<modelo> · <saúde>`

| Caso (pior par do catálogo) | Linha | Colunas |
|---|---|---|
| saudável | `ASTRO v0.1.0-alpha.4 · openai-compatible/meta/llama-3.3-70b-instruct · ok` | 74 |
| sem check | `… · n/d` | 75 |
| provider fora | `… · down` | 76 |

- Teto de 80 colunas. Sobram 4 no pior caso do catálogo (`openai-compatible` + `meta/llama-3.3-70b-instruct`); versão, provider e saúde são fixos.
- Acima de 80, o modelo é cortado no meio com `…`, preservando provider e saúde. Nunca quebra linha, nunca esconde a saúde.
- Saúde é `ok`, `n/d` ou `down`; `down` em vermelho, `n/d` em cinza.
- Endpoint sai do header: vive em `/status` e em `/log`. A versão fica porque é o primeiro dado de um bug report.
- A borda da caixa sai; a cor do texto segue a saúde.

## Footer

Formato: `pasta · N turno(s) · in/out tokens · custo · orçamento · modo`

| Campo | Quando aparece |
|---|---|
| pasta | Sempre; `~` para o home |
| turnos | Só com `N > 0` |
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

- `pensando… passo n/max`, com `max = agent.maxSteps`.
- Lacuna conhecida: `ChatSession.send` devolve `steps` só no fim, sem evento de passo. A implementação exige um `onStep` na sessão; fica registrada como issue própria, sem mudar este desenho.

## /log

| Move para `/log` | Fica inline |
|---|---|
| `turno concluído · N step(s)` | mensagens do usuário e do assistente |
| Linha `[modelo] N step(s) · tokens · total` por turno | erro com próximo passo |
| Transições de saúde do provider | pergunta de aprovação e diff |
| Avisos de orçamento repetidos | progresso `passo n/max` |
| Detalhe de tool: nome, duração, custo | aviso de contexto, uma vez |

- `/log` abre a tela com o buffer da sessão; `/log <n>` mostra as últimas `n` linhas.
- O buffer é de memória: a fonte durável continua sendo audit/ledger.

## Estados removidos

- Endpoint no header.
- Provider, modelo, saúde e modo repetidos no footer.
- Toast de turno concluído.
- Toast de erro duplicando a linha de erro.
- Linha de status por turno na área de conversa.
- `pensando…` coexistindo com toast de conclusão.

## Como verificar

- Header: a tabela de 80 colunas acima é o teste; o pior par do catálogo mede 74.
- Footer: nenhum campo do header aparece nele.
- Avisos: cada linha desta página aparece em uma única coluna da tabela de `/log`.

## Fora de escopo

- Tema, mouse e novos keybinds.
