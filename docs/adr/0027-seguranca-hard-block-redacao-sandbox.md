# ADR-0027: segurança — classes de path, hard-block, redação e sandbox

- Status: aceita
- Data: 2026-11-05
- Issue: #384
- Decisões relacionadas: ADR-0019, ADR-0023, ADR-0026, I-01, I-03, I-11

## Contexto

O classificador atual (`src/permissions.ts`) trata `.astro`/`.git`, nomes críticos e padrões de segredo, mas a matriz de permissões ainda libera `read_critical`/`critical_write` em `bypass`; `redactSecrets` cobre prefixo/env conhecidos, não entropia; `run_command` trunca antes de redigir; e o sandbox não monta hard-block. O ADR-0026 depende deste para implementar leitura de anexo com path seguro. Redação é defesa em camadas, nunca cobertura: lista de padrões não substitui bloqueio de path.

## Decisão

**Classes e precedência.** `hard-block > sensitive > normal`. A classificação roda sobre o `realpath`, com case-folding em win32/darwin e `~` expandido; symlink é resolvido antes. Sobrepasição entre classes **declaradas pelo usuário** (`allow-sensitive`/`allow-critical`) é erro de configuração; sobreposição entre as listas default é resolvida pela precedência, sem erro de runtime.

- **hard-block imutável (sem override):** `.env` e `.env.*`, exceto os sufixos de template (`*.env.example`, `*.example`, `*.sample`, `*.template`, `*.dist`); `.ssh/`; `id_rsa`; `id_ed25519`; `*.pem`; `*.key`; `.aws/credentials`; `.gnupg/`; `.kube/config`; `$ASTRO_HOME/keys/`; `vault.json`; `auth.json`; `astro.config.json`; `.astro` do cwd; `.git`; `protectedPaths`; todo `$ASTRO_HOME` fora do `artifactRoot` (cofre, trusted, providers, ledger, sessions). Nenhuma tool lê, escreve, lista conteúdo ou gera diff; vale em **todos** os modos, `bypass` incluído. Negar cita path e classe, nunca conteúdo.
- **hard-block configurável (padrão, liberável por path exato):** caminhos que casam `CRITICAL_PATH_PATTERN` (`(^|[._-])(secret|token|key|password|passwd|credential)([._-]|$)`, `src/permissions.ts`) e não estão no tier imutável. Entram como hard-block por padrão; só `allow-critical` (abaixo) os reclassifica.
- **sensitive (sensitive but useful):** templates, `.env.example`, e o que o usuário declarar em `allow-sensitive`. Leitura permitida com padrões + entropia; nunca verbatim; nunca é classe de destino do `allow-critical`.
- **normal:** sem gate de classe adicional. Redação de saída continua obrigatória em toda tool (ver Redação); `normal` não isenta nada de I-03.

**Isenção única (ADR-0026).** O `artifactRoot` validado é o único subtree isento do hard-block, só como destino de artefato e leitura por `ref` revalidado (hash, sessão/linhagem, raiz revalidada). Nunca é fonte de `/attach`, drag-drop, `read_file` ou shell. O regime da raiz (dedicação, permissão, TTL/GC, revalidação) é dono do ADR-0026; aqui fica só a isenção e a comparação por segmento no realpath (`isWithin`/`relative` sem `..`, nunca `startsWith`).

**Liberação.** `allow-sensitive` é allowlist aditiva (glob permitido, limitada e auditada). `allow-critical --i-understand` é allowlist **aditiva e auditada** de realpath/basename **exato** (sem glob, limite de itens, `--i-understand` obrigatório), avaliada **antes** da classificação: a entrada sai do tier configurável e vira `normal`, nunca do tier imutável (entrada que case o tier imutável falha com `allow_critical_invalid`). Só flag/config do usuário; config de projeto é ignorada. Toda liberação registra path, classe, motivo e origem, sem segredo. Hard-block imutável não tem override de modo, de `--i-understand` nem de config.

**Redação.** Vale para **toda** saída e **todo** diff, em qualquer classe: `read_file` aplica `redactSecrets` e, no tier sensitive/configurável, padrões + entropia (`security.entropyThreshold`, dono ADR-0028/`src/config.ts`; entropia é best-effort, só redige/nega, nunca libera); `run_command` redige stdout/stderr **antes** do truncamento e usa só padrões (entropia em shell gera falso positivo em hash/UUID/base64), e o artefato do `output-limit` é gravado já redigido; `grep`, `lsp`, web, saída de tool e compactação redigem antes de entrar no contexto/prompt/sumário; `edit`/executor aplicam a classe do path. Segredo nunca em contexto, log, audit, ledger ou memória (I-03). A exceção de imagem não redigível é a única do I-03 e segue o ADR-0026.

**Diffs.** hard-block: nenhum conteúdo; a timeline grava `[arquivo crítico alterado — conteúdo omitido]` com path e tool call na **tentativa negada** e em mudança externa detectada. Sensitive/configurável: diff linha a linha redigido. Normal: verbatim, mas ainda redigido.

**Shell e sandbox.** O hard-block de shell **depende do mount do sandbox** (I-11); o scan é defesa em profundidade e UX, nunca a fronteira. O sandbox (engine Linux, `src/tools/run-command.ts`) monta cada item do hard-block como arquivo vazio mascarado (bind de um arquivo temporário vazio, portável em Linux/Windows-host) ou árvore vazia somente-leitura (`.git`, `$ASTRO_HOME/keys`, `protectedPaths`), e reescaneia o cwd antes de cada execução; `.git` mascarado quebra comandos `git` dentro do sandbox — custo aceito, `git` roda no host por tool auditada. O scan bloqueia o comando que cita qualquer item do hard-block (não só `.env`/`.ssh`/`id_rsa`/`*.pem`/`.aws`/`.gnupg`/`.kube`) e cita o match; arquivo criado depois do start fica fora do mount (limite documentado). Com `sandbox: false`, `run_command` é **recusado** quando o cwd contém item do hard-block (erro tipado, I-19), porque sem mount não há fronteira; nos demais casos mantém redação e avisa no boot/banner. `~/.ssh`, `.aws`, `$ASTRO_HOME/keys` ficam fora do container e são cobertos pelo hard-block no dispatch, com a ausência de mount declarada no `doctor`.

**Erros.** `path_hard_blocked`, `path_sensitive_denied` (leitura/escrita verbatim de sensitive ou escrita sem aprovação), `allow_critical_invalid` — classes tipadas (donos `src/permissions.ts`/`src/tools/`), mensagem em português citando só o path relativo e a classe; nunca ecoa conteúdo.

## Consequências

- Ganho: classes explícitas, bloqueio impossível de contornar por modo e redação em todos os pontos de saída; ADR-0026 destravado.
- Custo: listas e entropia no config, scan de shell, mounts no sandbox, `git` fora do sandbox e testes POSIX/Windows.
- Invariantes afetadas: I-03 (dono do texto), I-11 (path), I-01 (allowlist); I-19 (parada graciosa) nas recusas.

## Alternativas descartadas

- Redação como cobertura: não detecta segredo sem padrão conhecido.
- `allow-critical` removendo o hard-block imutável: transforma config clonada em bypass.
- Scan de shell como fronteira: glob, `git log -p` e caminhos não citados escapam.
- Entropia no `run_command`: falso positivo em hash/UUID/base64.
- Só mount, sem hard-block no dispatch: arquivos fora do container escapam.
- Manter `bypass` lendo caminho crítico: o modo vira bypass de I-03.
