# Paridade de configuração: CLI, TUI e REPL

Objetivo: uma só configuração efetiva; cada ajuste tem um dono e um arquivo, e nenhuma superfície mantém store de config paralelo. Responde D-CFG2 e Q-10 (#453); a decisão está em D-31.

| Cobre | Não cobre |
|---|---|
| Precedência, autoridade por ajuste, o que cada superfície lê/grava, resposta de Q-10 e migração de stores | Implementação (lacunas no fim), semântica de budget/permissões (ADR-0013/0019) e sharing via registry (`config push/pull`) |

## Referência OpenCode

Comparado com o OpenCode: o núcleo descobre uma config única (`packages/core/src/config`, `opencode.json`/`.jsonc`, com precedência sistema/global/explicit/projeto) e cada cliente guarda só estado local de UI (`packages/cli/src/config`, incluindo a migração do TUI v1).

| Superfície OpenCode | Paridade | Decisão no ASTRO |
|---|---|---|
| config do núcleo (global/projeto/explicit) | mesma | `$ASTRO_HOME/config.json` + projeto (`astro.config.json`/`--config`), ADR-0029 |
| preferências do cliente (tema, abas) | mesma | `.astro/tui.json`, estado de UI, descartável |
| app/desktop/web como clientes adicionais | não se aplica | ASTRO é local: CLI, TUI e REPL no mesmo processo e nas mesmas camadas |
| flags de CLI | mesma | efêmeras; vencem a invocação, nunca gravam |
| servidor/sync de config | não se aplica | só `config push/pull` explícito via registry |

## Precedência (normativa)

As camadas e as regras de merge são de ADR-0029; esta seção aplica o recorte às três superfícies.

| # | Camada | Origem | Quem grava |
|---|---|---|---|
| 1 | defaults de código | `BASELINE_LAYER` e defaults de `validateConfig` | ninguém |
| 2 | global | `$ASTRO_HOME/config.json` (`ASTRO_HOME`, default `~/.astro`) | usuário; CRUD de provider da TUI/REPL (alvo de #401, após #459); import único de #459 |
| 3 | projeto | `astro.config.json` do cwd ou `--config` | usuário; `config pull`; `/config` da TUI; `providers vault-import` |
| 4 | invocação | `--provider`, `--permission-mode`, `ASTRO_PROVIDER`, `ASTRO_PERMISSION_MODE`, `--allow-critical`/`--allow-sensitive`, `--no-global-config` | ninguém; existe só no processo |

- `--config` troca só a camada 3; a global continua valendo. `--no-global-config`/`ASTRO_NO_GLOBAL_CONFIG=1` removem a camada 2.
- Objetos mesclam em profundidade; arrays substituem, exceto `models` (união por `provider/id`, projeto vence); escalares substituem.
- O projeto nunca amplia a política global: tools, perfil de agente, `permissions.mode`, budget, quotas, endpoint de credencial e `quotaDomain` passam por `assertNarrowed`; violação é erro, não override.
- Provider ativo: `--provider` > `ASTRO_PROVIDER` > `activeProfileId` > provider de `agent.model`. `agent.profile` vence a seleção de store/env; `--provider` divergente é erro.
- Modo: `--permission-mode` > `ASTRO_PERMISSION_MODE` > `permissions.mode` > `ask`. O perfil efêmero `OPENAI_*` só é selecionado quando a config não define um provider/modelo e nunca é gravado.

## Autoridade por ajuste (Q-10)

| Ajuste | Persistido em | CLI | TUI | REPL | Classe / por quê |
|---|---|---|---|---|---|
| providers, models, pricing, quota, paths, MCP, plugins | camadas 2–3 | lê | lê + CRUD guiado | lê + CRUD guiado | compartilhado: contrato do run |
| provider ativo | `activeProfileId` (store legado; `config.json` pós-#459) | `--provider` efêmero | tela; só perfil global | `/provider use`; só global | compartilhado; flag CLI-only |
| modelo do turno | `agent.model`/`modelPool` (camadas 2–3) | sem flag | `lastModel` no boot; `/model` em runtime | só config; `/model` em runtime | compartilhado; memória TUI-only |
| `permissions.mode` | camada 3 | `--permission-mode`/env efêmeros | `/config` grava; `/mode` runtime | `/config` só imprime; `/mode` runtime | compartilhado; persistência TUI-only |
| trust | `$ASTRO_HOME/state.json` | pergunta no TTY | pergunta; revoga no `/config` | pergunta | compartilhado; revogação TUI-only |
| tema, `lastModel`, favoritos, recentes | estado de UI (`.astro/tui.json` hoje; #468 define a raiz) | não lê | lê/grava | não lê | TUI-only: preferência de terminal |
| sessões | `.astro/sessions/` hoje; `$ASTRO_HOME` por projeto em #468 | sem comando | picker (renomeia/exclui/retoma) | lista/retoma | compartilhado; exclusão TUI-only |
| `--allow-critical`/`--allow-sensitive`/`--i-understand` | invocação | entrada | herda | herda | CLI-only: allowlist é ato explícito (ADR-0027) |
| `--artifact-root` | invocação de `chat`/`tui` | entrada | herda | herda | CLI-only na entrada, compartilhado na sessão |
| `config push/pull`, `providers vault-import`, `doctor --fix`, `config migrate` (alvo) | camada 3/2, `$ASTRO_HOME` | executa | não expõe | não expõe | CLI-only: operação administrativa |
| primeiro run / setup de provider | nenhum arquivo por default | `run` exige config | abre setup automático | erro com instrução | TUI-only hoje; alvo: contrato comum quando S3 (#469) definir a criação |

## Flag versus valor gravado (Q-10)

| Regra | Comportamento |
|---|---|
| R1 | Flag vence só a invocação e nunca grava; ao sair, o valor gravado volta. |
| R2 | Flag inválida (provider inexistente, modo inválido) falha antes do run; não cai no valor gravado. |
| R3 | `--provider` divergente de `agent.profile` é erro; seleção de env/store divergente gera aviso e é ignorada. |
| R4 | Status, `/provider` e a tela de providers mostram o valor efetivo e a origem (`providerSelection`/`providerSource`, auditados em `run.started`), não o gravado. |
| R5 | Escrita na camada de projeto não pode ampliar a global (ex.: `mode: bypass` com global `ask`): o merge tem de falhar e o arquivo ficar intacto. |
| R6 | `--no-global-config` também recusa escrita na camada global (pós-#459, `GlobalStoreDisabledError`); não cria arquivo alternativo. |
| R7 | Sem TTY, `ask` nega e para (#461); `bypass` explícito continua valendo. Nenhuma superfície troca o modo sozinha. |

## D-CFG2: um store, não dois

A TUI e o REPL **não** criam store de configuração próprio. Escrevem os mesmos arquivos da CLI, por um escritor validado e atômico (`updateConfigFile` para a camada de projeto; o mesmo contrato para a global após #459); divergência é bug, não contrato.

| Arquivo | Guarda | Lido por | Gravado por |
|---|---|---|---|
| `$ASTRO_HOME/config.json` | config global: providers, models, preferências; sem segredo | CLI/TUI/REPL | usuário; CRUD da TUI/REPL (após o escritor de config, #401); import de #459 |
| `astro.config.json`/`--config` | política do projeto | CLI/TUI/REPL | usuário; `config pull`; `/config` da TUI; `vault-import` |
| `$ASTRO_HOME/state.json` | trust e `migrations.*` | todas | prompt de trust (TTY), revogação da TUI, migrações |
| `$ASTRO_HOME/vault.json` | segredo de API key (OAuth Codex: `~/.codex/auth.json`) | runtime | wizard da TUI; `vault-import --apply` |
| `$ASTRO_HOME/providers.json` | legado pré-#459 | só antes de `migrations.providers` | import-only pós-#459; escrita recusada |
| `$ASTRO_HOME/trusted.json` | legado de trust | só antes de `migrations.trust` | import-only (#403) |
| `.astro/tui.json` | tema, `lastModel`, favoritos, recentes | só TUI | só TUI |

- `.astro/tui.json` é estado de UI, não config: ausente ou inválido cai nos defaults, o CLI/REPL nunca leem e ele não vence config explícita. A exceção é `lastModel` no boot da TUI, e só sem `--provider`; `--provider` desliga a memória. #468 move a raiz desse estado para `$ASTRO_HOME` (tema global com override por projeto); a autoridade continua TUI-only.
- `activeProfileId` mora junto dos providers (store legado; `config.json` pós-#459); `lastModel` é dica de UI. Depois de `/model`, `●` (ativo salvo) e `em uso` (sessão) podem divergir — é esperado.
- Perfil de projeto e perfil `env` são somente leitura nas telas; ativar um deles é runtime-only. Só perfil global grava `activeProfileId`.

## Migração e retrocompatibilidade

- A TUI não introduz migração própria: reusa as camadas; `tui.json` é opcional e descartável.
- #459 importa `providers.json` uma vez para `config.json` e marca `migrations.providers`; depois disso o legado é import-only (preservado byte a byte, não lido, escrita recusada). `trusted.json` seguiu o mesmo padrão em #403.
- Antes de #459, o CRUD da TUI/REPL ainda grava o store legado; é a janela de migração, não uma segunda fonte. Depois de #459 e antes do escritor de config (#401), o CRUD recusa com `ProfileStoreMigratedError`; o alvo é um só: `config.json`.

## Lacunas de implementação

| Lacuna | Efeito hoje | Onde |
|---|---|---|
| CRUD de provider da TUI/REPL gravar `config.json` | com #459, `saveProfileStore` recusa e o CRUD para; falta o escritor de config | próximo slice de #401; issue nova |
| `providers vault-import` de perfil global gravar `config.json` | mesmo bloqueio pós-#459 | idem |
| `/config` validar o merge com a camada global antes de gravar | `updateConfigFile` valida só a camada: um `mode` mais largo passa, a sessão aplica e o próximo load falha em `assertNarrowed` | issue nova (contrato R5) |
| `astro config migrate` e `CONFIG_SCHEMA_VERSION` (ADR-0028) | não há migração de major nem rejeição de chave desconhecida | issue nova |
| `config pull` usa `writeFileSync` simples | não é atômico/0600 como os demais escritores | issue nova |
| `/config` em projeto sem arquivo | modo não persiste; S3 não cria config | #469 |
