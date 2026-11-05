# ADR-0026: anexos — modelo, limites, paths e redação

- Status: aceita
- Data: 2026-11-05
- Issue: #382
- Decisões relacionadas: ADR-0010, ADR-0015, ADR-0020, ADR-0021, ADR-0023, ADR-0027 (a abrir), I-01, I-02, I-03, I-11

## Contexto

O harness hoje aceita prompt de texto e menções `@path`; não há modelo tipado de anexo, limites por turno nem política de path fora do cwd. O plano v3.0 precisa de anexos de texto/imagem/diretório sem abrir caminho para segredo, path fora do cwd ou prompt gigante.

## Decisão

**Modelo.** Anexo = `{kind: text|image|directory, path?, name, sizeBytes, mediaType, range?, ref?}`. `sizeBytes` é o payload que entra no prompt (texto UTF-8 após range/redação, imagem decodificada, listagem de diretório). `text`: `path?`, `mediaType` text/*, `range` 1-based. `image`: `path`, `mediaType` png/jpeg/webp/gif, sem `range`. `directory`: `path`, `mediaType` `inode/directory`, sem `range`. O `kind` vem de magic bytes, não da extensão; texto passa por redação mesmo se declarado imagem.

**Paths.** `@path` no editor cria **só menção**; leitura só por `/attach`, `/paste` ou drag-drop. Canonicalizar com `realpath` e comparar ao cwd com case-folding em win32/darwin; `../` e symlink que escapa são “fora do cwd” e seguem a confirmação, não um bloqueio separado. Hard-block `.astro`/`.git`/`isCriticalPath` no realpath, sem override (`bypass` incluído); o leitor de anexo **não** herda o allow de `read_critical`; ADR-0027 é pré-requisito. Fora do cwd: confirmação mostrando o absoluto canônico; sem TTY nega e para (I-19). Anexo só nasce de superfície humana (`/attach`, `/paste`, drag-drop; menção no editor não lê); nunca de modelo, tool, plugin, skill ou subagente (I-01/I-02).

**Imagem.** `redactSecrets` é textual; imagem não é redigível: confirmação por turno mostrando path/bytes/MPx e “não redigível”; sem TTY nega e para. Bytes de imagem vão para artefato `.astro/attachments` (0600) com hash; session store/export guardam só `ref`/hash/metadados; no resume, reidrata do artefato e valida o hash; ausente/corrompido vira erro tipado e parada (I-19). Antes de decodificar, ler header (IHDR/SOF): 25 MPx, 8192 px no lado maior e 20 MiB decodificados; `attachments.image.autoResize` (default false) redimensiona para 2048 px no lado maior; provider sem `vision` rejeita.

**Limites e ordem.** `stat` antes de ler: arquivo >20 MiB só com `range` (streaming, teto de 20 MiB lidos); sem range, rejeita. Pipeline: canonicalizar → range → redigir → medir UTF-8. Texto 20 MiB/anexo; imagem 20 MiB decodificada; listagem conta; **40 MiB combinados por turno** = conteúdo decodificado (texto+imagem+listagem). O pré-check conta tokens com D-22/ADR-0015, reserva `input + max_output` (ADR-0023), valida o tamanho codificado (base64 ~4/3) e o limite do provider; excedente rejeita **antes do request**, em português, sem compactação silenciosa; o `guardContext` atual não é backstop.

**Conteúdo e ledger.** O ledger grava só metadados/`ref`, nunca conteúdo. O conteúdo fica no prompt e, quando persistido, no session store (ADR-0010/0021) ou em artefato com `ref`; `ref` só de artefato da mesma sessão criado por superfície humana, com hash/classe, revalidado ao usar; nunca de modelo/tool/plugin/skill/subagente. `usage` continua por chamada; este ADR **supersede** a contabilidade de custo separada por forma do plano (anexo não cria `usage`); bytes/tokens estimados podem acompanhar o turno como metadado sem custo, com schema do ADR-0023. Arquivo/clipboard é **dado não confiável** (prompt injection), nunca instrução.

**Diretório e bordas.** Não recursivo; 500 entradas após filtros (hard-block, `.astro`/`.git`; ocultos só com `attachments.directory.showHidden`); acima pede filtro; listagem nome+tamanho conta no cap. Dedupe por realpath+range; clipboard por hash do conteúdo; conta uma vez. Remoção antes do envio permitida; 0 byte texto ok, 0 byte imagem rejeita; binário fora do whitelist rejeita; SVG texto. `@path#start-end` só se o sufixo casar `^\d+-\d+$`, `start >= 1` e o path sem sufixo existir; se o path literal com `#` existir, ele vence; `end` além do EOF clampa. `/attach` fuzzy interno; diálogos nativos plugin opcional; `Ctrl+V` texto fica no prompt; imagem do clipboard adiada.

## Consequências

- Ganho: entrada multimodal tipada, limites/testes claros e path/segredo sob a política existente.
- Custo: `/attach`/`/paste` na TUI, limites e confirmação canônica de path; imagem de clipboard adiada; implementação bloqueada até ADR-0027 (hard-block).
- Invariantes afetadas: I-03 (redação), I-11 (path), I-01/I-02 (escopo); I-12 só confirma que anexo não é tool.

## Alternativas descartadas

- `@path` anexando conteúdo sem gate: bypass de allowlist/permissão.
- Anexo como tool call: muda o contrato de tool e o custo.
- Ledger com conteúdo do anexo: viola I-03 e infla o log.
- Cap só em bytes sem contexto: aceita anexo que nunca caberia na janela.
- Redigir imagem: `redactSecrets` é textual; falso controle.
- Imagem só em memória sem `ref`: resume perde o turno silenciosamente.
