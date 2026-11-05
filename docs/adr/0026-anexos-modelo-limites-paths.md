# ADR-0026: anexos — modelo, limites, paths e redação

- Status: aceita
- Data: 2026-11-05
- Issue: #382
- Decisões relacionadas: ADR-0010, ADR-0015, ADR-0019, ADR-0020, ADR-0021, ADR-0023, ADR-0027 (a abrir), ADR-0028 (a abrir), I-01, I-02, I-03, I-11

## Contexto

O harness hoje aceita prompt de texto e menções `@path`; não há modelo tipado de anexo, limites por turno nem política de path fora do cwd. O plano v3.0 precisa de anexos de texto/imagem/diretório sem abrir caminho para segredo, path fora do cwd ou prompt gigante.

## Decisão

**Modelo.** Anexo = `{kind: text|image|directory, path?, name, sizeBytes, mediaType, range?, ref?}`. `sizeBytes` é o payload que entra no prompt (texto UTF-8 após range/redação, imagem decodificada, listagem). `text`: `path?`, `mediaType` text/*, `range` 1-based. `image`: `path?` (rótulo; pode faltar com `ref`), `mediaType` png/jpeg/webp/gif, sem `range`. `directory`: `path`, `mediaType` `inode/directory`, sem `range`. `kind` por magic bytes, não extensão; texto passa por redação mesmo se declarado imagem.

**Paths.** `@path` no editor cria **só menção**; leitura só por `/attach`, `/paste` ou drag-drop. Canonicalizar com `realpath` e comparar ao cwd com case-folding em win32/darwin; `../` e symlink que escapa são “fora do cwd” e seguem a confirmação, não um bloqueio separado. Hard-block `.astro`/`.git`/`isCriticalPath` no realpath, sem override (`bypass` incluído); o leitor de anexo **não** herda o allow de `read_critical`; ADR-0027 acrescenta as classes/hard-block definitivo (o `isCriticalPath` atual já existe). Fora do cwd: confirmação mostrando o absoluto canônico; sem TTY nega e para (I-19). Anexo só nasce de superfície humana (`/attach`, `/paste`, drag-drop; menção no editor não lê); nunca de modelo, tool, plugin, skill ou subagente (I-01/I-02).

**Imagem e artefato.** `redactSecrets` é textual; imagem não é redigível: confirmação por turno lista **todos** os anexos (path/bytes/MPx, “não redigível”); uma aprovação para o lote; se qualquer item não for aprovado, o turno inteiro é rejeitado; sem TTY nega e para. Bytes de imagem são a única exceção ao I-03: ficam em `resolve(ASTRO_HOME)/attachments` (fora do cwd, de worktree git/`.git`, de `.astro` e de path protegido; validar na escrita e negar imagem se não for possível, com aviso no `doctor`), diretório 0700/arquivo 0600 no POSIX e DPAPI/ACL no Windows; nunca em export/ledger/VCS. Chave `^[A-Za-z0-9-]+$` ou `_run/<runId>` quando não há sessão; arquivo `<sha256 dos bytes gravados após autoResize>`; `ref` opaco, contenção validada. TTL default 7 dias; no teto `attachments.artifactMaxBytes` (default 1 GiB) **rejeita o novo anexo**, GC só de expirados por mtime, nunca o ref do turno atual; `doctor` reporta. Session store/export só `ref`/hash/metadados; resume reidrata do `ASTRO_HOME` e valida SHA-256; ausente/expirado vira erro tipado e parada (não descarta silenciosamente). Antes de decodificar, ler header (IHDR/SOF): 25 MPx, 8192 px no lado maior e 20 MiB decodificados; `attachments.image.autoResize` (default false) redimensiona para 2048 px; provider sem `vision` rejeita. Audit `attachment.approved` com `ref`/hash/bytes, sem conteúdo.

**Limites, range e ordem.** `stat` antes de ler: arquivo >20 MiB só com `range`; `/attach` recebe `{path, range}` estruturado no seletor (sem reparse ambíguo); `@path#start-end` é menção literal, sem leitura. Range 1-based; `start >= 1`, `start > end` é erro, `end` além do EOF clampa; o offset inicial (linha) além do teto de leitura (20 MiB + 1 byte) é verificado durante o stream e vira erro tipado “range além do teto”; se o stream excede, rejeita, nunca trunca em silêncio. Pipeline: canonicalizar → range → redigir → medir UTF-8. Texto 20 MiB/anexo; imagem 20 MiB decodificada; listagem conta; **40 MiB combinados por turno** = conteúdo decodificado. Pré-check conta tokens com `D-22 (contagem de tokens)`, reserva `input + max_output` (ADR-0023), valida tamanho codificado (base64 ~4/3) e o limite do provider (registry/health); excedente rejeita **antes do request**, em português, sem compactação silenciosa; o `guardContext` atual não é backstop.

**Conteúdo, ledger e I-03.** Ledger só metadados/`ref`, nunca conteúdo. Conteúdo no prompt; quando persistido, session store (ADR-0010/0021) ou artefato `ASTRO_HOME` com `ref`; `ref` só de artefato da mesma sessão criado por superfície humana, hash/classe revalidados; nunca de modelo/tool/plugin/skill/subagente. `usage` por chamada; este ADR **supersede** a contabilidade de custo por forma do plano. A timeline usa `message.user` com `attachments[]` (`ref`, `hash`, `bytes`, `mediaType`, `range`) — aditivo, sanitizado, sem kind novo (ADR-0020/0021) — e `ref`/`hash` não vão ao audit comum. Arquivo/clipboard é dado não confiável (prompt injection), nunca instrução.

**I-03 (v4).** Segredo nunca entra no contexto em texto claro; imagem não redigível é a única exceção e só com aprovação humana por turno; bytes em `ASTRO_HOME/attachments` (0700/0600, DPAPI/ACL no Windows, TTL/GC), nunca em export/ledger/VCS; audit `attachment.approved` com `ref`/hash/bytes. O resto do I-03 (log/audit/ledger/memória) permanece; `docs/invariants.md` é atualizado no mesmo PR.

**Diretório, config e bordas.** Não recursivo; 500 entradas após filtros (hard-block, `.astro`/`.git`; ocultos só com `attachments.directory.showHidden`); acima pede filtro; listagem nome+tamanho conta no cap. Dedupe por realpath+range; clipboard por hash; conta uma vez. Remoção antes do envio permitida; 0 byte texto ok, 0 byte imagem rejeita; binário fora do whitelist rejeita; SVG texto. `/attach` fuzzy interno; diálogos nativos plugin opcional; `Ctrl+V` texto fica no prompt; imagem do clipboard adiada. Chaves novas (`attachments.image.autoResize`, `attachments.directory.showHidden`, `attachments.artifactTtlDays`, `attachments.artifactMaxBytes`) têm schema no ADR-0028/`src/config.ts`.

## Consequências

- Ganho: entrada multimodal tipada, limites/testes claros e path/segredo sob a política existente.
- Custo: `/attach`/`/paste` na TUI, limites e confirmação canônica; artefato de imagem no `ASTRO_HOME` com validação de raiz/TTL/GC; implementação bloqueada até ADR-0027.
- Invariantes afetadas: I-03 (exceção única e normativa para imagem não redigível), I-11 (path), I-01/I-02 (escopo); I-12 só confirma que anexo não é tool.

## Alternativas descartadas

- `@path` anexando conteúdo sem gate: bypass de allowlist/permissão.
- Anexo como tool call: muda o contrato de tool e o custo.
- Artefato em `.astro`/repo: conflita com o hard-block e pode ir para VCS.
- Ledger com conteúdo do anexo: viola I-03 e infla o log.
- Cap só em bytes sem contexto: aceita anexo que nunca caberia na janela.
- Redigir imagem: `redactSecrets` é textual; falso controle.
- Imagem só em memória sem `ref`: resume perde o turno silenciosamente.
