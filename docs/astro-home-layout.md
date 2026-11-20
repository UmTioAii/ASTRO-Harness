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

`projectKey(projectPath)` (`src/home-layout.ts`) é o caminho canônico, escapado byte a byte:

| Etapa | Regra |
|---|---|
| absoluto | `resolve(path)` |
| separador | `\` vira `/` só no win32 (onde `\` é separador); no POSIX `\` é caractere literal |
| caixa | dobrada em `win32` e `darwin` (`foldPathCase`, a mesma regra de `src/path-class.ts`); preservada no resto |
| `/` (separador) | `_s` |
| `[A-Za-z0-9.-]` | o próprio caractere |
| qualquer outro (inclusive `_`) | `_x<hex>` por byte UTF-8, sempre com dois dígitos |

O escape é injetivo — `_s` e `_x..` nunca se confundem, e o hex tem largura fixa —, então `/a/b`, `/a_b`, `/\x01f` e `/\x1f` caem em chaves distintas: dois projetos nunca compartilham diretório. A dobra de caixa acompanha o filesystem: no APFS/NTFS o mesmo diretório digitado com outra caixa é o mesmo projeto (senão sessões e skills "sumiriam"); no Linux, `/A` e `/a` continuam projetos distintos.

Acima de `PROJECT_KEY_MAX_BYTES` (120 bytes, abaixo do limite de 255 de um nome de diretório) a chave vira `sha256-<32 hex>` do caminho canônico. O corte é exato: no teto ainda é o caminho legível, um byte acima já é hash. Determinístico e estável entre execuções.

## Tema e precedência

`loadTuiConfig(cwd)` mescla camadas: override do projeto > `$ASTRO_HOME/tui.json` > default (`dark`). Cada campo vence por si; uma lista presente no projeto — inclusive vazia — substitui a global, então dá para limpar favoritos num projeto. Arquivo ausente, inválido ou que escapa do `$ASTRO_HOME` por link vale como vazio (leitura tolerante); na escrita, a guarda roda antes de qualquer `mkdir` e um alvo que escapa é recusado (`caminho de estado fora do $ASTRO_HOME`, I-11) sem deixar diretório fora do home. A escrita grava só a camada do projeto, sem copiar valores globais.

## Escopo e permissões

- Toda raiz de estado é validada contra o `$ASTRO_HOME` canônico antes de criar qualquer coisa: `ensureDirInside` checa o ancestral existente mais profundo, cria com `0700` e checa de novo; um junction preexistente em `projects/<chave>` ou em `sessions/` é recusado (`isInsideHome`), e a purga de cópia legada não apaga nada fora do home.
- `SessionApi`, `saveTuiConfig` e a instalação de skill compartilham os mesmos helpers (`ensureAstroHome`/`ensureDirInside`/`ensurePrivateDir`), então home, `projects/`, a chave do projeto e a raiz de skills nascem `0700` (arquivos de estado `0600` no POSIX).

## O que continua no `.astro/` do projeto

O `.astro/` do cwd é a camada do projeto e não é movido: `ledger`/`audit` (defaults `paths.*`), `memory.md` do projeto, `compaction/`, `exports/`, `outputs/` e os checkpoints de `loop-guard` (ADR-0010), que seguem em `<cwd>/.astro/sessions/<run>/<agent>/`. Nenhum deles passa a viver em `$ASTRO_HOME` nesta fatia.

## Migração

Nada é migrado, copiado ou apagado (#468, fora de escopo). Por caminho legado:

| Local | Depois de #468 |
|---|---|
| `~/.astro/skills` | continua sendo a raiz de skills do usuário enquanto `ASTRO_HOME` não for definido (é o mesmo `$ASTRO_HOME/skills` do default); com `ASTRO_HOME` definido, a raiz passa a ser a do novo home e a antiga não é lida |
| `<cwd>/.astro/skills` | não é mais lido (a raiz do projeto é a chave em `$ASTRO_HOME`); o diretório fica intacto |
| `<cwd>/.astro/sessions.db` | não é mais lido nem gravado; o arquivo fica intacto |
| `<cwd>/.astro/sessions/` | continua sendo o store de checkpoints do `loop-guard` (ADR-0010) e **não pode ser apagado**; o JSON v1 de sessões que ficava aqui não é mais importado |
| `<cwd>/.astro/tui.json` | não é mais lido nem gravado; o arquivo fica intacto |

A ausência de criação no primeiro run é #469.
