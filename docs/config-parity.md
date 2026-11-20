# Paridade de configuração: CLI, TUI e REPL

Objetivo: uma só configuração efetiva; cada ajuste tem um dono e um arquivo, e nenhuma superfície mantém store de config paralelo. Responde D-CFG2 e Q-10 (#453); a decisão está em D-31.

| Cobre | Não cobre |
|---|---|
| Precedência, autoridade por ajuste, o que cada superfície lê/grava, resposta de Q-10 e migração de stores | Implementação (lacunas no fim), semântica de budget (`ADR-0013`) e de permissões (`ADR-0027`/D-24) e sharing via registry (`config push/pull`) |

## Referência OpenCode

Comparado com o OpenCode: o núcleo descobre uma config única (`packages/core/src/config`, `opencode.json`/`.jsonc`, com precedência sistema/global/explicit/projeto) e cada cliente guarda só estado local de UI (`packages/cli/src/config`, incluindo a migração do TUI v1).

| Superfície OpenCode | Paridade | Decisão no ASTRO |
|---|---|---|
| config do núcleo (global/projeto/explicit) | mesma | `$ASTRO_HOME/config.json` + projeto (`astro.config.json`/`--config`), ADR-0029 |
| preferências do cliente (tema, abas) | mesma | `$ASTRO_HOME/tui.json` (global) e `$ASTRO_HOME/projects/<chave>/tui.json` (override), estado de UI, descartável (#468) |
| app/desktop/web como clientes adicionais | não se aplica | ASTRO é local: CLI, TUI e REPL no mesmo processo e nas mesmas camadas |
| flags de CLI | mesma | efêmeras; vencem a invocação, nunca gravam |
| servidor/sync de config | não se aplica | só `config push/pull` explícito via registry |

## Precedência (normativa)

As camadas e as regras de merge são de ADR-0029; esta seção aplica o recorte às três superfícies.

| # | Camada | Origem | Quem grava |
|---|---|---|---|
| 1 | defaults de código | `BASELINE_LAYER` e defaults de `validateConfig` | ninguém |
| 2 | global | `$ASTRO_HOME/config.json` (`ASTRO_HOME`, default `~/.astro`) | usuário; import único de #459; `vault-import` de perfil global (store hoje, `config.json` após #459); CRUD de provider da TUI/REPL (alvo de #401, após #459 — #492) |
| 3 | projeto | `astro.config.json` do cwd ou `--config` | usuário; `/config` da TUI (`permissions.mode`); `config pull`; `vault-import` de provider do projeto |
| 4 | invocação | `--provider`, `--permission-mode`, `ASTRO_PROVIDER`, `ASTRO_PERMISSION_MODE`, `--allow-critical`/`--allow-sensitive`, `--no-global-config` | ninguém; existe só no processo |

- `--config <path>` escolhe o arquivo da camada 3 (default `astro.config.json`, resolvido do cwd); a camada 2 continua valendo. `--no-global-config` vale para qualquer comando, grava `ASTRO_NO_GLOBAL_CONFIG=1` no processo e remove a camada 2 (o env sozinho faz o mesmo); o store de perfis continua sendo lido hoje e só é desligado quando #459 entrar. Nenhum dos dois é persistido.
- Objetos mesclam em profundidade; arrays substituem, exceto `models` (união por `provider/id`, projeto vence); escalares substituem.
- O projeto não amplia as chaves cobertas por `assertNarrowed`: tools e perfil de agente, `permissions.mode`, budget, quotas, endpoint de credencial, `quotaDomain` e `tools.run_command.sandbox` (auto/Docker > Docker > desligado: o projeto endurece, mas não reabre o host quando o global força Docker; #474). `paths` e `security` não passam por essa guarda; nas chaves cobertas, violação é erro, não override.
- Provider ativo: `--provider` > `ASTRO_PROVIDER` > `activeProfileId` > provider de `agent.model`. `agent.profile` vence a seleção de store/env; `--provider` divergente é erro.
- Modo: `--permission-mode` > `ASTRO_PERMISSION_MODE` > `permissions.mode` > `ask`. O perfil efêmero do ambiente (`OPENAI_*`, `NVIDIA_*` ou `OPENROUTER_*`) só entra quando nem as camadas (projeto/global) nem o store resolvem provider + modelo, ou quando `ASTRO_PROVIDER` nomeia um conjunto completo; nunca é gravado e usa `ASTRO_PROVIDER` como único seletor (#472).

## Autoridade por ajuste (Q-10)

| Ajuste | Persistido em | CLI | TUI | REPL | Classe / por quê |
|---|---|---|---|---|---|
| providers e models | camadas 2–3 | lê | lê + CRUD guiado (provider/perfil) | lê + CRUD guiado (provider/perfil) | compartilhado: contrato do run |
| pricing, quota, paths, MCP, plugins | camadas 2–3 | lê | lê | lê | compartilhado; edição só no arquivo |
| provider ativo | `activeProfileId` (store legado hoje; `config.json` após #459/#492) | `--provider` efêmero | tela; só perfil global | `/provider use`; só global | compartilhado; flag CLI-only |
| modelo do turno | `agent.model`/`modelPool` (camadas 2–3) | sem flag | `/model` em runtime; `lastModel` só vale sem `agent.model` declarado (#497) | só config; `/model` em runtime | compartilhado; memória TUI-only |
| `permissions.mode` | camada 3 | `--permission-mode`/env efêmeros | `/config` grava; `/mode` runtime | `/config <chave> <valor>` grava; `/mode` runtime | compartilhado; persistência TUI+REPL (#558) |
| knobs editáveis (`agent.maxSteps`, `budget.*`, `team.*BudgetUsd`, `permissions.mode`, `shell.default`) | camada 3 | lê | tela `/config` (tecla `e`) e `/config chave valor` gravam | `/config chave valor` grava | whitelist fechada em `EDITABLE_CONFIG_KEYS`; pré-valida teto global antes de gravar; preset `simple` read-only nos knobs de controle (#558) |
| `shell.default` | camada 3 | lê | `/shell <shell> confirm` grava | `/shell <shell> confirm` grava | shell do fallback host no `auto` (ADR-0031); só vocabulário de `HOST_SHELLS` e só shell presente na máquina (#474) |
| `permissions.approvalTimeoutMs` | camada 3 | lê | `/config` só imprime | lê | compartilhado; teto da espera por aprovação (#526) |
| trust | `$ASTRO_HOME/state.json` | pergunta no TTY | pergunta; revoga no `/config` | pergunta | compartilhado; revogação TUI-only |
| tema, `lastModel`, favoritos, recentes | estado de UI: global em `$ASTRO_HOME/tui.json`, override por projeto em `$ASTRO_HOME/projects/<chave>/tui.json` (#468) | não lê | lê/grava | não lê | TUI-only: preferência de terminal |
| sessões | `$ASTRO_HOME/projects/<chave>/sessions.db` (SQLite; `sessions/` ao lado é o JSON v1 importado; #468) | sem comando | picker: lista/renomeia/exclui/retoma | lista/retoma/exclui (TTY) | compartilhado; renomear TUI-only |
| `--allow-critical`/`--allow-sensitive`/`--i-understand` | invocação | entrada | herda | herda | CLI-only: allowlist é ato explícito (ADR-0027) |
| `--artifact-root` | invocação de `chat`/TUI | entrada | herda | herda | CLI-only na entrada, compartilhado na sessão |
| `config push/pull`, `providers vault-import`, `doctor --fix`, `config migrate` | camada 3/2, `$ASTRO_HOME` | executa | não expõe | não expõe | CLI-only: operação administrativa |
| primeiro run / setup de provider | TUI cria `astro.config.json` (só `agent.model` do perfil global ativo) e `$ASTRO_HOME/config.json` se ausentes, sempre `wx` 0600 — sem provider ainda, só o global nasce e o setup cria os dois juntos (#559) | `run` exige config | abre setup automático | erro com instrução | contrato comum quando S3 (#469) definir a criação |

## Flag versus valor gravado (Q-10)

| Regra | Comportamento |
|---|---|
| R1 | Flag vence só a invocação e nunca grava; ao sair, o valor gravado volta. |
| R2 | Flag inválida (provider inexistente, modo inválido) falha antes do run; não cai no valor gravado. |
| R3 | `--provider` divergente de `agent.profile` é erro; seleção de env/store divergente gera aviso e é ignorada. |
| R4 | Status (footer da TUI e linha do REPL) e `/details` mostram o provider/modelo efetivos, não a seleção gravada; não mostram a origem. `run.started` audita `providerSource`/`providerSelection`. |
| R4b | A lista de providers mostra a origem: a TUI sempre (`[source]`) e o REPL em `/provider list`; `/providers` mostra `credentialRef`, não a origem. |
| R5 | Escrita na camada de projeto não pode ampliar a global (ex.: `mode: bypass` com global `ask`): o merge tem de falhar e o arquivo ficar intacto. O `/config` verifica o teto global antes de gravar (#494). |
| R6 | `--no-global-config` remove a camada global de config, mas hoje ainda lê/grava o store de perfis; quando #459 entrar, o store também é desligado e a escrita falha com `GlobalStoreDisabledError` (planejado). Não cria arquivo alternativo. |
| R7 | Sem TTY, `ask` nega e para (#461); `bypass` explícito continua valendo. Nenhuma superfície troca o modo sozinha. |

## D-CFG2: um store, não dois

A TUI e o REPL **não** criam store de configuração próprio. O contrato é escrever os mesmos arquivos da CLI, por um escritor validado e atômico: `updateConfigFile` para a camada de projeto, `saveProfileStoreToConfig`/`updateGlobalProviderCredentialRef` para a global (#492/#491) e `writeConfigFileAtomic` no `config pull` (#495). Divergência é bug, não contrato.

| Arquivo | Guarda | Lido por | Gravado por |
|---|---|---|---|
| `$ASTRO_HOME/config.json` | config global: providers, models, preferências; provider guarda só referência de credencial; `mcpServers.*.env`/`args` não têm screening — lacuna (#496) | CLI/TUI/REPL | usuário; import de #459; CRUD da TUI/REPL (#492); `vault-import --apply` (#491) |
| `astro.config.json`/`--config` | política do projeto | CLI/TUI/REPL | usuário; `/config` da TUI (`permissions.mode`); `config pull`; `vault-import` de provider do projeto |
| `$ASTRO_HOME/state.json` | trust e `migrations.*` | todas | prompt de trust (TTY), revogação da TUI, migrações |
| `$ASTRO_HOME/vault.json` | segredo de API key (OAuth Codex: `~/.codex/auth.json`) | runtime | wizard da TUI; `vault-import --apply` |
| `$ASTRO_HOME/providers.json` | legado pré-#459 | só antes de `migrations.providers` | import-only após #459; escrita recusada |
| `$ASTRO_HOME/trusted.json` | legado de trust | só antes de `migrations.trust` | importado e preservado; `saveTrustedStore` com caminho explícito ainda grava |
| `$ASTRO_HOME/tui.json` | tema e preferências globais da TUI (camada base) | só TUI | usuário (editado à mão) |
| `$ASTRO_HOME/projects/<chave>/tui.json` | override do projeto: tema, `lastModel`, favoritos, recentes | só TUI | só TUI |

- O estado da TUI é estado de UI, não config: ausente ou inválido cai nos defaults, o CLI/REPL nunca leem e ele não vence config explícita. `lastModel` no boot da TUI só é aplicado quando a config não declara `agent.model` e sem `--provider` (#497): o modelo declarado nunca é trocado em silêncio (I-08).
- #468 moveu a raiz desse estado para `$ASTRO_HOME`: tema global com override por projeto, e o `.astro/tui.json` legado não é lido nem apagado (`docs/astro-home-layout.md`); a autoridade continua TUI-only.
- `activeProfileId` mora junto dos providers (store legado; `config.json` após #459/#492); `lastModel` é dica de UI. Depois de `/model`, `●` (ativo salvo) e `em uso` (sessão) podem divergir — é esperado.
- O rótulo de exibição do provider vive em `providers.<id>.name` no `config.json` e faz round-trip pelo CRUD/dump (#492); no projeto, o mesmo campo vence o id na lista. Escrita em `config.json`/`astro.config.json` que seja symlink é recusada com `config_write_denied` (#495). `config.json` inválido faz o CRUD falhar fechado (nada é gravado) até a camada ser corrigida.
- Na lista de perfis (`/provider list` no REPL, tela da TUI), projeto e o perfil efêmero do ambiente aparecem com `[source]`, mas são somente leitura; ativar é runtime-only. Só perfil global grava `activeProfileId`.

## Migração e retrocompatibilidade

- A TUI não introduz migração própria: reusa as camadas; `$ASTRO_HOME/tui.json` é opcional e descartável, e o legado `.astro/tui.json` fica intacto sem ser lido (#468).
- #459 importa `providers.json` uma vez para `config.json` e marca `migrations.providers`; depois disso o legado é import-only (preservado byte a byte, não lido, escrita recusada com `ProfileStoreMigratedError`, nome planejado em #459).
- `trusted.json` é importado e preservado (#403); depois de `migrations.trust` não é mais lido, mas `saveTrustedStore` não recusa escrita em caminho explícito — diferente de `providers.json` após #459.
- Antes de #459, o CRUD da TUI/REPL ainda grava o store legado; é a janela de migração, não uma segunda fonte. Quando #459 entrar e antes de #492, o CRUD recusa; o alvo é um só: `config.json`.
- Schema da config (ADR-0028, #493): implementado e igual nas duas camadas, checado por camada de origem antes do merge e antes de qualquer erro de forma. Ausente = `0.0.0` (legado), aceito e migrado em memória; major à frente falha fechado. `astro config migrate [--config <path>] [--apply]` é o único escritor da migração — dry-run por default, atômico, idempotente e CLI-only. Chave removida (ex.: `run.maxTurns`) não é migrada por `config migrate`: o erro dedicado indica o substituto (`agent.maxSteps`).

## Lacunas de implementação

| Lacuna | Efeito hoje | Onde |
|---|---|---|
| `/config` em projeto sem arquivo | TUI cria o arquivo no first-run (#559), então persiste; fora da TUI, modo não persiste e S3 não cria config | #469 |

- `preset` (`simple`/`control`, default `control`) é escalar: a camada de projeto vence. Em `simple`, `agent.maxSteps` e `agents.*.maxSteps` têm teto 500: um valor menor vindo de outra camada é mantido e acima de 500 é erro com `preset: "control"` como próximo passo; sem `agent.maxSteps`, o teto efetivo é 500 (#515). Também só no `control` (#552): `agents.maxActive`, `spawn.maxActive`, `team.sessionBudgetUsd` e `team.weekBudgetUsd` — em `simple`, declarar qualquer um é erro de config.

