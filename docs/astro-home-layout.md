# Layout do estado em `$ASTRO_HOME`

Skills, sessões e estado da TUI vivem em `$ASTRO_HOME` (#468, S2 de #401); a chave do projeto é o caminho, com hash só acima do teto.

| Cobre | Não cobre |
|---|---|
| Raízes de skills, sessões por projeto, tema, chave do projeto e o que continua no `.astro/` do projeto | Precedência de configuração (`docs/adr/0029-config-global-home.md`), formato de skill (`docs/skills.md`), primeiro run (#469) |

## Layout

`$ASTRO_HOME` é `ASTRO_HOME` quando definido, senão `~/.astro` (`src/astro-home.ts`).

| Caminho | Conteúdo | Dono |
|---|---|---|
| `$ASTRO_HOME/skills/<nome>/` | skill do usuário (`user/<nome>`) | `skills` CLI, loader |
| `$ASTRO_HOME/projects/<chave>/skills/<nome>/` | skill do projeto (`project/<nome>`) | `skills` CLI, loader |
| `$ASTRO_HOME/projects/<chave>/sessions.db` | store SQLite de sessões do projeto | `/sessions`, `/resume`, auto-save |
| `$ASTRO_HOME/projects/<chave>/sessions/` | JSON v1 que o SQLite importa e reconcilia | `src/chat/session-api.ts` |
| `$ASTRO_HOME/tui.json` | tema e preferências globais da TUI | usuário; só a TUI lê |
| `$ASTRO_HOME/projects/<chave>/tui.json` | override do projeto (tema, `lastModel`, favoritos, recentes) | só a TUI grava |

- Estado privado: diretório 0700 e arquivo 0600 (POSIX) onde o conteúdo é estado; no Windows vale a ACL herdada do perfil do usuário.
- `$ASTRO_HOME` é hard-block fora do `artifactRoot` (ADR-0027): tools, shell e anexos continuam sem acesso a essas raízes.
- Nada é criado fora de `$ASTRO_HOME` por causa deste layout, e nenhum arquivo legado é removido. Ver "Migração" abaixo.

## Chave do projeto

`projectKey(projectPath)` (`src/home-layout.ts`) é o caminho canônico — absoluto, com `/` e caixa dobrada no win32 (mesmo diretório, mesma chave) — escapado byte a byte:

| Entrada | Chave |
|---|---|
| `/` (separador) | `_s` |
| `[A-Za-z0-9.-]` | o próprio caractere |
| qualquer outro (inclusive `_`) | `_x<hex>` por byte UTF-8 |

O escape é injetivo, então `/a/b` e `/a_b` nunca caem na mesma chave: dois projetos nunca compartilham diretório.

Acima de `PROJECT_KEY_MAX_BYTES` (120 bytes, abaixo do limite de 255 de um nome de diretório) a chave vira `sha256-<32 hex>` do caminho canônico. O corte é exato: no teto ainda é o caminho legível, um byte acima já é hash. Determinístico e estável entre execuções.

## Tema e precedência

`loadTuiConfig(cwd)` mescla camadas: override do projeto > `$ASTRO_HOME/tui.json` > default (`dark`). Cada campo vence por si; lista do projeto substitui a global quando presente. Arquivo ausente, inválido ou que escapa do `$ASTRO_HOME` por link vale como vazio (leitura tolerante); na escrita, um alvo que escapa é recusado (`estado da TUI fora do $ASTRO_HOME`, I-11). A escrita grava só a camada do projeto, sem copiar valores globais.

## O que continua no `.astro/` do projeto

O `.astro/` do cwd é a camada do projeto e não é movido nem lido como fallback: `ledger`/`audit` (defaults `paths.*`), `memory.md` do projeto, `compaction/`, `exports/`, `outputs/` e os checkpoints de `loop-guard` (ADR-0010). Nenhum deles passa a viver em `$ASTRO_HOME` nesta fatia.

## Migração

Nada é migrado, copiado ou apagado (#468, fora de escopo): `~/.astro/skills`, `<cwd>/.astro/skills`, `<cwd>/.astro/sessions.db`, `<cwd>/.astro/sessions/` e `<cwd>/.astro/tui.json` ficam intactos byte a byte e deixam de ser lidos. Com o default `~/.astro` a raiz de skills do usuário não muda de lugar; o que muda é a raiz de skills do projeto, as sessões e o estado da TUI. A ausência de criação no primeiro run é #469.
