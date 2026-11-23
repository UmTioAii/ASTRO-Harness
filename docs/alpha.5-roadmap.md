# Roadmap alpha.5 — realinhamento

Este documento existe porque o harness saiu do rumo. Ele não é uma lista de tarefas: é o
contrato do produto, e cada fase abaixo deriva dele.

## 1. Missão

O ASTRO é um harness de **governança**: custo, token, quota, resposta e trilha sob
controle, com ferramentas boas e multi-agente sobre multi-modelo de multi-provider.

O diferencial não é "ter chat". É o usuário conseguir responder, a qualquer momento:
*quanto gastei, com quem falei, o que o agente viu, o que ele fez e por quê.* Harness que
só conversa já existe de graça.

## 2. Dois públicos, explícitos

O harness tem **dois** perfis de uso. Eles não são "níveis de dificuldade": são contratos
diferentes.

| | **Default** (usuário normal) | **Control** (quer controle) |
|---|---|---|
| Quer | usar a LLM e resolver a tarefa | controlar custo, modelo, limite, conta, política |
| Vê número de turno/rodada? | **nunca** | em `/config`, `/usage` e no relatório |
| Custo na tela | **sim, quando o modelo tem preço cadastrado**; oculto em grátis ou preço desconhecido | sim, por turno/sessão/semana/mês, com preço e sem preço |
| Configura em `/config` | modelo, provider, tema, permissão, pasta confiável | tudo do Default **mais** budget, quota, teto de turnos, rodadas (avançado), fallback, multi-agente |
| Default do produto | **é ele** | precisa escolher explicitamente |

**Decisão de produto:** hoje o default é `preset: "control"` (`src/core/config.ts:146`),
ou seja, o usuário normal nasce vendo a parafernália. Isso inverte a missão. O default
passa a ser **Default** (`preset: "default"`), e Control é opt-in explícito, com aviso no
`/config` de que ele expõe limites e custo.

### Trocar de perfil

- `/config preset control` (ou `astro config preset control`) promove o projeto para
  Control, com confirmação que lista o que passa a existir: budget, quota, teto de turnos,
  válvula de rodadas e custo detalhado. Reversível com `preset default`.
- Grava no `astro.config.json` do projeto; `--global` aplica em todo lugar.
- O perfil em uso aparece no rodapé. No Default não existe atalho para Control fora do
  `/config` — promoção é ato explícito, não clique acidental.

### Setup inicial (primeira execução)

Roda na primeira execução, **sempre** — é o único caminho que cria config. Nada de config
criada em silêncio por outro passo.

**Quando roda, por camada:**

| Estado | O que acontece |
|---|---|
| sem config global **e** sem config de projeto | wizard completo |
| global existe, projeto não | mini-setup do projeto (perfil + pasta confiável), reaproveitando providers do global |
| projeto existe | não roda; nunca sobrescreve |

**Fluxo completo:** termos → perfil → provider → modelo → chave → TUI.
**Fluxo curto** (provider veio do ambiente): termos → perfil → TUI, com a linha
*"usando `<provider>` de `$OPENROUTER_API_KEY` — trocar?"* e uma tecla para cair no fluxo
completo.

**Precedência quando há mais de uma variável:** a ordem do catálogo, e o wizard sempre diz
qual escolheu. Nunca escolhe silenciosamente entre duas.

**Nunca bloqueia máquina:** sem TTY (CI, pipe, `astro run` em script) não pergunta nada —
uma linha de aviso, defaults em memória, **nenhuma escrita**. `astro setup` reabre o wizard;
`--yes` aceita os defaults num terminal.

**O que cada camada ganha:**
- **global** (`$ASTRO_HOME/config.json`): providers, modelos e `credentialRef`;
- **projeto** (`astro.config.json`): `preset` e o modelo escolhido;
- **chave**: cofre (DPAPI no Windows, arquivo `0600` no POSIX) ou `credentialRef` para
  ambiente — **nunca** no config, em nenhuma das duas camadas.

**Integração obrigatória:** o wizard absorve o `ensureFirstRunConfig` (#559) e roda na
mesma posição do portão dos termos (`src/tui/run.tsx:212`, antes de `ensureFirstRun()`).
Se rodar depois, nunca verá "sem config" — outro passo já criou.

**Não criar um terceiro fluxo de provider (auditoria).** Já existem dois: o wizard linear
de `/provider add|edit` (`src/chat/provider-wizard.ts`, usado pelo REPL) e a tela cheia da
TUI (`src/tui/provider-screen.tsx`, 706 linhas). O setup **reusa** o primeiro e o segundo
passa a chamá-lo, em vez de nascer uma terceira implementação de "escolher provider e
gravar chave".

## 3. O modelo de limites, mastigado

Três coisas, três escopos. Nenhuma delas é "quantidade de trabalho": são **contadores de
eventos**.

| Evento | Definição | Escopo | Quem conta hoje |
|---|---|---|---|
| **Turno** | seu prompt → resposta final. Contém N chamadas ao modelo e M ferramentas. | sessão | `#turns` (`src/chat/agent-session.ts:200`) — **sem teto** |
| **Rodada** | uma chamada ao modelo + as ferramentas que ela pediu | dentro de um turno | `for (let step…)` (`src/core/session.ts:503`) — **é o teto atual** |
| **Ferramenta** | uma execução de tool | dentro de uma rodada | não tem contador próprio |

### Exemplo concreto

Pedido: *"refatore o módulo X"*. O modelo chama o LLM 14 vezes e executa 31 ferramentas
antes de responder.

- Isso é **1 turno**, com **14 rodadas** e **31 ferramentas**.
- Hoje: `agent.maxSteps = 500` conta as 14 rodadas. Um turno que precise de 600 rodadas
  **morre no meio do raciocínio** e a sessão pode ter turnos infinitos.
- Novo: `run.maxTurns = 500` conta **turnos**; a válvula de rodadas só existe para dizer
  "esse turno entrou em loop".

### Por que os dois não brigam

Eles não competem: **multiplicam**. O pior caso é `turnos × rodadas`, e nenhum delta de
uso normal chega perto de nenhum dos dois. A regra que evita o conflito:

- **Turno é política** — conversa com o usuário, aparece em Control, some no Default.
- **Rodada é válvula de segurança** — não é orçamento; dispara só quando o turno não
  converge. A detecção principal de loop continua sendo `noProgressSegments` (ADR-0014);
  a válvula é o último recurso.
- Configurar rodada baixa é possível em Control, mas o `/config` avisa que aquilo corta
  raciocínio legítimo.

### Decisão de nomes no código

`step` é o nome errado para rodada e colide com o vocabulário dos SDKs (o `max_turns` do
OpenAI Agents SDK conta chamadas ao LLM, exatamente nossa rodada). Renomear
`step` → `round` no código e no diagnóstico; `turn` fica reservado para o turno.

## 4. Nada de contador na conversa

Decisão explícita: **a TUIX não mostra passo, rodada nem contagem de ferramentas.**

O que ela mostra:
- a timeline (prompt → raciocínio recolhível → ferramentas com estado → resposta);
- um indicador de atividade, sem número;
- ao **atingir** um limite, uma frase humana: *"parei aqui: esta tarefa não convergiu"*,
  com a ação possível (`/config`, continuar, ver relatório);
- custo no Default quando há preço cadastrado; janelas e contadores detalhados só no Control.

Números de progresso vivem em `/usage`, `/config`, no relatório e no audit — nunca na conversa.

### `/usage`

Default e Control mostram tokens de entrada, saída e escritos e custo acumulado do modelo e
da sessão. Control adiciona turnos/rodadas, janelas (sessão/semana/mês) e budget restante;
Default nunca mostra contadores. Modelo sem preço cadastrado aparece `n/d`, sem quebrar a soma.

## 5. Referências e o que adaptamos

| Fonte | O que tem | O que adotamos | O que **não** copiamos |
|---|---|---|---|
| OpenAI Agents SDK | `max_turns` por run, `None` desliga, `MaxTurnsExceeded` com handler que devolve resposta controlada | erro tipado + handler que fecha o turno com mensagem humana em vez de stack | expor `max_turns` como knob de config do usuário |
| opencode | config com `tool_output`, `compaction`, `subagent_depth`, `permissions`; **zero** knob de laço | a ideia: laço é do harness; o usuário configura saída, contexto e política | a forma de config (JSONC com `$schema`) — nosso ADR-0028 já define a nossa |
| Claude Code | `--max-turns` como flag de execução não-interativa | flag para modo script/CI, onde não há humano para decidir | transformar isso em config de projeto |
| opencode — catálogo | `providers/<vendor>.ts` só transporte; fatos vêm do snapshot do models.dev (`core/src/models-dev/snapshot.txt`) | separação transporte ≠ fato | depender de snapshot externo: queremos curadoria (effort/tools) |
| opencode — subagente | sessão filha em background, `sessionID` devolvido na hora, aviso `<background-result>` ao ficar idle, `subagent` com o mesmo `sessionID` para follow-up, `subagent_depth` default 1 | filho não bloqueia o pai; filho retomável; profundidade 1 | rodar sempre em background: queremos foreground quando o pai depende do resultado |
| opencode — retry | `retry-after` do 429 com teto de 15 min, exponencial 2s→10s, 10 tentativas, jitter, orçamento separado para rede inalcançável (`model-retry.ts`) | backstop reativo idêntico em espírito | — |
| openclaude — catálogo | `src/integrations/models/<família>.ts` com `defineModel` + flags de capacidade | curadoria tipada por família | `brandId`/`classification` como eixos separados: não precisamos |
| openclaude — agentes | `agentRouting` (tipo de agente → chave de modelo/provider) e `agentModels` (rota com ou sem credencial própria); `maxSteps` no frontmatter que, ao estourar, **pede resumo** ao filho | roteamento por agente e resumo forçado em vez de morte | chave de API em `settings.json` em texto puro |
| openclaude — smart routing | classifica o turno em simple/strong, uma decisão por turno, off por default | "uma decisão por unidade, sem flap" | classificador heurístico por tamanho de prompt: temos `modelRouting` explícito |
| Anthropic — multi-agente | orquestrador + workers; brief com objetivo, formato de saída, tools e fronteiras; regras de esforço por tamanho da tarefa; custo de 15× tokens vs chat; falha por "atualizações excessivas" entre agentes | brief obrigatório, escala de esforço, custo explícito e teto de mensagens entre filhos | paralelismo como padrão: no código, a maioria das tarefas não é paralelizável |
| OpenAI Agents SDK — handoff | handoff é **tool** (`transfer_to_<agente>`), transfere a conversa, com `input_filter` para decidir o que o receptor vê | handoff como tool explícita e filtro do que atravessa | transferir o histórico inteiro: nosso filho nasce com brief, não com transcript |
| A2A (protocolo) | `Task` (ciclo de vida), `Message`, `Part`, `Artifact`; streaming e webhook | vocabulário de artefato/tarefa; artefato é o contêiner de resultado | transporte HTTP e Agent Card: somos processo local, não federação |

Regra da casa: **ideia, organização e código deles; implementação nossa**, adaptada ao
nosso contrato (ADR, invariantes I-01/I-03/I-11, allowlist deny-by-default).

## 6. Fases e specs

Cada fase tem spec própria, e a spec é dona do contrato. Este documento fica com a ordem, as
decisões e os riscos; o detalhe implementável vive nas specs.

```
P0   contrato de limites + perfil Default/Control
 |
P0.5 shell no host (sem Docker): regras + scanner + aprovação
 |
P1   fundação da timeline (eventos por turno)
 |
P2   TUIX (espinha dorsal) ──── P3  catálogo de modelos + adapters
 |                              |
 |                              P4  agentes, subagentes, concorrência
P5   tools
 |
P5.5 web (search + fetch)
 |
P6   carry-over de segurança/CI
 |
P7   docs, README e repo público
```

**Ordem:** P0 e P0.5 primeiro (contrato), **P2 em paralelo com P3/P4** porque a TUIX é a
espinha dorsal e não pode esperar o catálogo, **P5/P5.5 depois**, **P7 por último** (traduzir
documento que ainda muda é desperdício).

| ID/fase | Issue | Status | Spec | Depende de |
|---|---|---|---|---|
| S1/P0 | #594 | **em andamento** | `2026-11-21-limits-and-profiles.md` | — |
| S2/P0.5 | #599 | planejado | `2026-11-21-host-shell.md` | #594 |
| S5a/P1 | #600 | planejado | `2026-11-21-turn-events.md` | #594 |
| S5/P2 | #595 | planejado | `2026-11-21-tuix-design.md` | #594, #600 |
| S3/P3 | #601 | planejado | `2026-11-21-model-catalog.md` | #594 |
| S4/P4 | #602 | planejado | `2026-11-21-agents-and-handoff.md` | #594, #601 |
| S6/P5 | #603 | planejado | `2026-11-21-tools-contract.md` | — |
| S7/P5.5 | #604 | planejado | `2026-11-21-web-tools.md` | #603 |
| P6 | #605 | planejado | carry-over abaixo | #604 |
| S8/P7 | #606 | planejado | `2026-11-21-docs-and-public-repo.md` | todas |

Specs em `docs/superpowers/specs/`. Todas as issues estão abertas para planejamento; só as
marcadas **em andamento** estão em execução. Aceite e ADR ficam na spec/issue dona do contrato.

### P6 — Carry-over verificado

1. `src/vault.ts` sem lock no read-modify-write (`withFileLock` existe e é usado em
   `audit`, `ledger`, `agent-lock`).
2. `src/sanitize-external.ts:54` redige valor só até o primeiro espaço.
3. `src/vault.ts:76` chama `powershell` pelo PATH.
4. CI sem execução em tag e sem `bun audit`.

Descartados após verificação: IPv4 alternativo no guard de URL (o `URL` canonicaliza),
`bypass` sem prompt (exige `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1`), "AGENTS diz zero deps"
(o doc já declara Ink/React como exceção).

### Contratos existentes que este pacote muda

| Documento | O que muda |
|---|---|
| `docs/adr/0014` e `docs/adr/0030` | perdem "turno é unidade de interação, não de limite" (P0, ADR-0033) |
| `docs/adr/0031` | supersededo: host é o único caminho ativo, Docker inativo (P0.5, ADR-0034) |
| `docs/adr/0009` A4 | revogado: concorrência por conta com reserva somada (P4, ADR-0037) |
| `docs/adr/0008` | o alias `maxTurns` do filho passa a significar turnos (P0) |
| `docs/tui-layout.md` | reescrito no PR de P2, não no P7 |
| `docs/provider-cards.md` | ganha a camada de fatos (P3) |
| `docs/security-threat-matrix.md` | reescrito no PR de P0.5 |
| `docs/config-parity.md` | schema 2.0.0 e os aliases (P0) |

## 7. Processo

- No máximo duas issues **em andamento** por vez; as demais ficam planejadas. A próxima
  dupla só começa com as duas mergeadas, respeitando as dependências da tabela.
- Duas revisões de contexto fresco por PR, com mutação declarada.
- Alvo 200 linhas, teto 400 com justificativa.
- ADR novo para: limites e perfis (0033), shell no host (0034, supersede 0031),
  timeline e eventos (0035), agentes e handoff (0036), concorrência por conta (0037,
  supersede A4 do 0009).
- RED observável em toda issue; suíte completa + typecheck verdes para fechar.

## 8. Decisões

Resolvidas:

1. **Perfil**: `preset: "default" | "control"`, com **default** como padrão do produto
   (`simple` aceito como alias) e troca explícita via `/config preset control`.
2. **`run.maxTurns`**: default **500**, com 250 / 500 / 1000 / ilimitado (aviso de gastos).
3. **Válvula de rodadas**: default **500**, com 100 / 200 / 500 / ilimitado (aviso de
   gastos e loop).
4. **Setup**: sempre na primeira execução e por camada (global/projeto); fluxo curto quando
   o provider vem do ambiente, com opção de trocar; sem TTY não pergunta e não escreve.
5. **Custo no Default**: aparece quando o modelo tem preço cadastrado.
6. **Scanner de shell**: tokenizer próprio, sem dependência.
7. **`always`**: grava a regra de prefixo no **projeto**.
8. **Shell e permissão**: allowlist pré-aprova, todo o resto pergunta (inclusive perigoso);
   o harness não impede, avisa; consentimento de risco no setup; `bypass` exige aceite e
   mostra aviso persistente.
9. **TUIX**: reescrever `src/tui` no lugar, sem `v2` atrás de flag.
10. **Catálogo**: TS tipado, em três camadas — `src/models/catalog.ts` (fatos do modelo,
    arquivo único) + `src/providers/<p>/<p>_models.ts` (oferta/preço + `overrides`, nome
    que já existe no #553) + `adapter.ts` (transporte/limites).
11. **Concorrência**: **2 agentes por provider** nos dois perfis (teto = nº de providers
    cadastrados), editável em `/config`; Control ajusta por provider, com budget e ledger
    como freio. Sem limitador proativo de RPM/TPM nesta fase — o retry reativo cobre.
12. **Retorno do subagente**: caminho feliz devolve **resumo** (não persistido); artefato
    de handoff só em exceção, no nível compacto de 512 tokens.
13. **Retomada**: `task.resume` (L2) explícito; L3 automático; L1 só por pedido do pai.
14. **Filhos conversando**: barramento por run, endereçamento direto, sem broadcast,
    limitado, com cópia de toda mensagem ao pai e artefato como payload.
15. **Profundidade**: **1, sem neto, nos dois perfis** — não configurável.
16. **Quantidade**: pedido explícito do usuário > `/config` > 2. O modelo **pede**, o
    harness concede até o teto e registra `agent.spawn` (pedido, concedido, motivo).
    Texto livre no prompt não é expandido por heurística do harness.

Resolvidas pela auditoria:

17. **Schema 2.0.0**: `run.maxTurns` volta com significado novo, então config `1.x` que
    declara a chave **falha** e pede confirmação explícita de versão. Nunca reinterpretar
    em silêncio.
18. **Alias, não reescrita**: chave antiga (`agent.maxSteps`, `sandbox`) carrega com aviso;
    `config migrate` não reescreve valor do usuário (contrato do ADR-0028 mantido).
19. **Docker inativo**: `shell.mode` só aceita `"host"` ou `"off"` no alpha.5; o caminho
    Docker fica no código, sem ser selecionável, com testes. Reativar ou remover é issue pós-release.
20. **Concorrência revoga ADR-0009/A4**: exclusividade por credencial vira concorrência
    controlada por conta, com reserva de budget somada por conta. ADR-0037.
21. **Idioma**: inglês é a língua do repositório — docs, ADRs, README, UI, erros e código
    novo. Só a conversa fica em pt-BR. Comentário legado se traduz ao tocar no arquivo, sem
    onda dedicada; não bloqueia release nem anúncio.

Nenhuma decisão pendente. O roadmap está fechado para virar issue.

## 9. Auditoria (2026-11-21)

Método: cada referência conferida no arquivo e na linha; cada contrato afirmado confrontado
com o ADR/doc que é dono do assunto; viabilidade checada contra o código real; sustentabilidade
medida (tamanho, testes, acoplamento).

**Referências: 14 de 14 corretas.** `agent-session.ts:200`, `config.ts:146`,
`session.ts:503`, `fan-out.ts:94`, `openai-compat.ts:314`, `sanitize-external.ts:54`,
`task.ts:3`, `run.tsx:212`, `vault.ts:76`, `compact.ts:16`, `spawn.ts:297`, mais
`config.ts:105-125`, `config.ts:1325-1338`, `session.ts:196-204`.

**Corrigido neste documento:** duas fases **ausentes** do pacote apesar de pedidas — web
(`web_search`/`web_fetch`, agora P5.5) e docs/README/repo público (agora P7); colisão
`maxTurns` (rodadas × turnos), contradição com `config-parity.md:99`/ADR-0028 sobre
migração, ausência de título na seção P1, nome `models.ts` contra `docs/provider-cards.md`,
contagem de RED (2 → 5), e os três conflitos de ADR (0014/0030, 0031, 0009).

**Riscos aceitos, com motivo:**

| Risco | Por que fica |
|---|---|
| Documento de ~316 linhas contra o limite de 150 | é plano temporário: cada fase, ao ser mergeada, troca a própria entrada por um resumo e o link do ADR. O tamanho cai sozinho. Já está no `docs/INDEX.md` com a exceção registrada |
| TUIX mexe em 33 arquivos de teste (~6,2k linhas; `tui-app.test.tsx` tem 1718) | reescrita visual quebra snapshot por definição; o custo é declarado na issue, não descoberto no PR |
| Scanner de shell próprio é código de segurança novo | fail-closed + matriz de teste dedicada; sem isso não entra |
| Concorrência dobra gasto concorrente | é o motivo de a reserva passar a somar por conta (decisão 20) |
| 9 specs + 5 ADRs (~1,2k linhas novas de doc) | um dono por assunto; ADR ≤60 linhas, spec ≤150 |
