# ADR-0027: segurança — classes de path, hard-block, redação e sandbox

- Status: aceita
- Data: 2026-11-05
- Issue: #384
- Decisões relacionadas: ADR-0019, ADR-0023, ADR-0026, I-01, I-03, I-11

## Contexto

O classificador atual (`src/permissions.ts`) trata `.astro`/`.git`, nomes críticos e padrões de segredo, mas a matriz de permissões ainda libera `read_critical`/`critical_write` em `bypass`; `redactSecrets` cobre prefixo/env conhecidos, não entropia; `run_command` trunca antes de redigir; e o sandbox não monta hard-block. O ADR-0026 depende deste para implementar leitura de anexo com path seguro. Redação é defesa em camadas, nunca cobertura: lista fechada de padrões não substitui bloqueio de path.

## Decisão

**Classes e precedência.** `hard-block > sensitiveButUseful > normal`; um path que caia em duas classes é erro de configuração. Classificação sobre o `realpath`, com case-folding em win32/darwin e `~` expandido; symlink é resolvido antes.

- **hard-block (imutável):** `.env*`, `.ssh/`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `.aws/credentials`, `.gnupg/`, `.kube/config`, `$ASTRO_HOME/keys/`, `vault.json`, `auth.json`, `astro.config.json`, `.astro` do cwd, `.git`. Nenhuma tool lê, escreve, lista conteúdo ou gera diff; vale em **todos** os modos, `bypass` incluído. Negar cita path e classe, nunca conteúdo.
- **sensitiveButUseful:** `*.env.example`, `*.example`, `*.sample`, `*.template`, `*.dist` e o que o usuário declarar. Leitura permitida com redação por padrão + entropia; nunca verbatim.
- **normal:** verbatim.

**Isenção única do ADR-0026.** O `artifactRoot` validado é o único subtree isento do hard-block, e só como **destino** de artefato e leitura por `ref` revalidado (hash, sessão/linhagem, raiz revalidada). Nunca é fonte de `/attach`, drag-drop, `read_file` ou shell. O resto de `$ASTRO_HOME` (cofre, trusted, providers, ledger, sessions) continua hard-blocked. A isenção é comparação por segmento no realpath (`isWithin`/`relative` sem `..`), nunca `startsWith`.

**Liberação.** `allow-sensitive` é allowlist aditiva de falsos positivos de padrão (glob permitido só aqui, limitada e auditada). `allow-critical --i-understand` é allowlist **aditiva e auditada** de realpath/basename exato (sem glob, limite de itens, `--i-understand` obrigatório) para falso positivo do padrão de nome, e nunca remove o conjunto imutável. Toda liberação registra path, classe, motivo e origem (flag/config), sem segredo; hard-block não tem override de modo nem de `--i-understand`. O conjunto imutável é apenas o desta decisão; entradas dele não são configuráveis.

**Redação.** `read_file` em sensível usa padrões + entropia (`security.entropyThreshold`, default conservador); `run_command` redige stdout/stderr **antes** do truncamento e usa só padrões (entropia em shell produz falso positivo em hash/UUID/base64); `grep`, `lsp`, web e saída de tool usam padrões; compactação redige antes do sumário; `edit`/executor aplicam a classe do path. Segredo nunca em contexto, log, audit, ledger ou memória (I-03). A exceção de imagem não redigível é a única do I-03 e segue o regime do ADR-0026.

**Diffs.** hard-block: nenhum diff; a timeline grava `[arquivo crítico alterado — conteúdo omitido]` com path e tool call. Sensível: diff linha a linha redigido. Normal: verbatim.

**Shell e sandbox.** Scan conservador do comando antes de executar: substring de `.env`, `.ssh`, `id_rsa`, `*.pem`, `.aws`, `.gnupg`, `.kube` bloqueia citando o match; falso positivo só por `allow-critical` auditado. O sandbox monta hard-block como `/dev/null` (arquivo) ou diretório vazio (árvore) e reescaneia o cwd antes de cada execução; arquivo criado depois do start fica fora (limite documentado). `sandbox: false` mantém hard-block + redação e avisa no boot/banner. `~/.ssh`, `.aws`, `$ASTRO_HOME/keys` ficam fora do container e são cobertos pelo hard-block no dispatch, com a ausência de mount declarada no `doctor`.

**Erros.** `path_hard_blocked`, `path_sensitive_denied` e `allow_critical_invalid` são classes tipadas (donos `src/permissions.ts`/`src/tools/`), com mensagem em português que cita só o path relativo e a classe; nunca ecoa conteúdo.

## Consequências

- Ganho: classes explícitas, bloqueio impossível de contornar por modo e redação em todos os pontos de saída; ADR-0026 destravado.
- Custo: listas e entropia no config, scan de shell, mount no sandbox, testes POSIX/Windows e matriz de permissões.
- Invariantes afetadas: I-03 (dono do texto), I-11 (path), I-01 (allowlist); I-19 (parada graciosa) nas recusas.

## Alternativas descartadas

- Redação como cobertura: não detecta segredo sem padrão conhecido.
- `allow-critical` removendo o hard-block: transforma config clonada em bypass.
- Entropia no `run_command`: falso positivo em hash/UUID/base64.
- Só mount, sem hard-block no dispatch: arquivos fora do container escapam.
- Manter `bypass` lendo caminho crítico: o modo vira bypass de I-03.
