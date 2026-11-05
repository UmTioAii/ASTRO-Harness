# ADR-0027: segurança — classes de path, hard-block, redação e sandbox

- Status: aceita
- Data: 2026-11-05
- Issue: #384
- Decisões relacionadas: ADR-0019, ADR-0023, ADR-0026, I-01, I-03, I-11

## Contexto

O classificador atual (`src/permissions.ts`) trata `.astro`/`.git`, nomes críticos e padrões de segredo, mas a matriz de permissões ainda libera `read_critical`/`critical_write` em `bypass`; `redactSecrets` cobre prefixo/env conhecidos, não entropia; `run_command` trunca antes de redigir; e o sandbox não monta hard-block. O ADR-0026 depende deste para implementar leitura de anexo com path seguro. Redação é defesa em camadas, nunca cobertura: lista de padrões não substitui bloqueio de path.

## Decisão

**Classes e precedência.** `hard-block > sensitive > normal`, sobre o `realpath`, com case-folding em win32/darwin e `~` expandido; symlink resolvido antes. Sobreposição entre as listas default é resolvida pela precedência; sobreposição entre entrada declarada pelo usuário e o tier imutável falha com `allow_critical_invalid`.

- **hard-block imutável (sem override):** `.env` e `.env.*` exceto os templates nomeados abaixo; `.ssh/`; `id_rsa`; `id_ed25519`; `*.pem`; `*.key`; `.aws/credentials`; `.gnupg/`; `.kube/config`; `$ASTRO_HOME/keys/`; `vault.json`; `auth.json`; `astro.config.json`; `~/.netrc`; `~/.npmrc`; `~/.docker/config.json`; `~/.config/gh/hosts.yml`; `*.p12`; `*.pfx`; `*.jks`; `*.kdbx`; `.astro` do cwd; `.git`; `protectedPaths`; todo `$ASTRO_HOME` fora do `artifactRoot`. Nenhuma tool lê, escreve, lista conteúdo ou faz diff; vale em **todos** os modos, `bypass` incluído. Negar cita path e classe, nunca conteúdo.
- **hard-block configurável (padrão, liberável por path exato):** caminhos que casam `CRITICAL_PATH_PATTERN` (`src/permissions.ts`, referência por símbolo, sem transcrever o regex) e não estão no tier imutável. Hard-block por padrão; só `allow-critical` os reclassifica.
- **sensitive:** `.env.example`, `*.env.example`, `*.example`, `*.sample`, `*.template`, `*.dist` e o que o usuário declarar em `allow-sensitive`. Leitura com padrões + entropia, nunca verbatim.
- **normal:** sem gate de classe; a redação de padrões continua em toda saída e diff (abaixo).

**Isenção única (ADR-0026).** O `artifactRoot` validado é o único subtree isento do hard-block, só como destino de artefato e leitura por `ref` revalidado (hash, sessão/linhagem, raiz revalidada); nunca fonte de `/attach`, drag-drop, `read_file` ou shell. O regime da raiz (dedicação, permissão, TTL/GC, revalidação) é dono do ADR-0026; aqui fica só a isenção e a comparação por segmento no realpath (`isWithin`/`relative` sem `..`, nunca `startsWith`). `.git` é hard-block para leitura por tool/diff/anexo, mas o shell pode operar os subcomandos git do gate abaixo.

**Liberação.** `allow-sensitive` (glob, limite de itens, auditada) e `allow-critical --i-understand` (realpath absoluto de **arquivo**, sem diretório, glob ou basename; `--i-understand` obrigatório) vêm de flag ou de `$ASTRO_HOME/security.json` (0600, dono do usuário); config de projeto é ignorada. `allow-critical` é avaliada **antes** da classificação: entrada que casa o tier imutável falha `allow_critical_invalid`; entrada que não casa o tier configurável é ignorada com aviso e audit. O path liberado vira `normal` (só padrões, sem entropia). Toda liberação audita realpath completo, classe, motivo e origem, sem segredo.

**Redação.** Vale para **toda** saída e **todo** diff: `read_file` aplica padrões sempre e padrões + entropia em sensitive (`security.entropyThreshold`, dono ADR-0028/`src/config.ts`; entropia é best-effort, só redige/nega, nunca libera); `run_command` redige stdout/stderr **antes** do truncamento, usa só padrões (entropia em shell gera falso positivo em hash/UUID/base64) e grava o artefato do `output-limit` já redigido; `grep`, `lsp`, web, saída de tool e compactação redigem antes do contexto/prompt/sumário; `edit`/executor aplicam a classe do path. Segredo nunca em contexto, log, audit, ledger ou memória (I-03). A exceção de imagem não redigível é a única do I-03 e segue o ADR-0026.

**Diffs.** hard-block: nenhum conteúdo; a timeline grava `[arquivo crítico alterado — conteúdo omitido]` com path e tool call na tentativa negada. Sensitive/configurável: diff linha a linha redigido. Normal: redigido por padrões.

**Shell e sandbox.** Shell exige sandbox (I-11). O sandbox monta cada item do hard-block conforme o `stat` — arquivo vira arquivo vazio mascarado (bind `ro`), diretório vira árvore vazia `ro` — e reescaneia o cwd antes de cada execução; item criado depois do start fica fora do mount (limite documentado). `.git` é montado rw (o fluxo de commit continua) com `.git/config` mascarado, e o gate só aceita subcomandos git sem saída de conteúdo (`status`, `rev-parse`, `diff --stat`, `log --oneline`, `add`, `commit`, `switch`, `restore`), bloqueando `show`, `cat-file`, `log -p`/`--patch`, `archive`, `bundle` e `grep`. O scan de substring cobre **todos** os itens do hard-block e é defesa em profundidade/UX, nunca a fronteira. Com `sandbox: false`, `run_command` **não executa** (`sandbox_required_for_shell`, I-19); as file tools mantêm hard-block + redação, e o boot/banner avisa. `~/.ssh`, `.aws`, `$ASTRO_HOME/keys` ficam fora do container e são cobertos no dispatch, com a ausência de mount declarada no `doctor`.

**Erros.** `path_hard_blocked`, `allow_critical_invalid`, `sandbox_required_for_shell` — classes tipadas (donos `src/permissions.ts`/`src/tools/`), mensagem em português citando só o path relativo e a classe; nunca ecoa conteúdo.

## Consequências

- Ganho: classes explícitas, bloqueio impossível de contornar por modo e redação em toda saída; ADR-0026 destravado.
- Custo: `sandbox: false` perde o shell; listas/entropia no config; mounts e gate de git no sandbox; testes POSIX/Windows.
- Invariantes afetadas: I-03 (dono do texto), I-11 (path/sandbox), I-01 (allowlist); I-19 (parada graciosa) nas recusas.

## Alternativas descartadas

- Redação como cobertura: não detecta segredo sem padrão conhecido.
- `allow-critical` removendo o hard-block imutável: transforma config clonada em bypass.
- Scan de shell como fronteira: glob, `git log -p` e caminhos não citados escapam.
- Entropia no `run_command`: falso positivo em hash/UUID/base64.
- Só mount, sem hard-block no dispatch: arquivos fora do container escapam.
- Manter `bypass` lendo caminho crítico: o modo vira bypass de I-03.
