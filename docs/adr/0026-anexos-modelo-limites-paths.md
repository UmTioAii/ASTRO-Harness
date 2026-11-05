# ADR-0026: anexos — modelo, limites, paths e redação

- Status: aceita
- Data: 2026-11-05
- Issue: #382
- Decisões relacionadas: ADR-0010, ADR-0015, ADR-0020, ADR-0021, ADR-0023, ADR-0027 (a abrir), I-01, I-02, I-03, I-11

## Contexto

O harness hoje aceita prompt de texto e menções `@path`; não há modelo tipado de anexo, limites por turno nem política de path fora do cwd. O plano v3.0 precisa de anexos de texto/imagem/diretório sem abrir caminho para segredo, path fora do cwd ou prompt gigante.

## Decisão

**Modelo.** Anexo = `{kind: text|image|directory, path, name, sizeBytes, mediaType, range?, ref?}`. `text`: `path?`, `mediaType` text/*, `sizeBytes` do conteúdo, `range` 1-based inclusivo. `image`: `path`, `mediaType` png/jpeg/webp/gif, `sizeBytes` decodificado, sem `range`. `directory`: `path`, `mediaType` `inode/directory`, `sizeBytes` 0, sem `range`. O `kind` vem de sniffing de magic bytes, não da extensão/`mediaType`; conteúdo textual passa por redação mesmo se declarado imagem.

**Paths e escopo.** `@path` no editor cria **só menção** (`@path`/`@path#start-end`); conteúdo só por `/attach`, `/paste` ou drag-and-drop, sempre pelo mesmo classificador do `read`. Classificação no **realpath** (`resolveWithin`), nunca na grafia: `../`, symlink/junction que escapa e `.astro/` bloqueiam; confirmação obrigatória quando o realpath difere do digitado ou sai do cwd, mostrando o absoluto; sem TTY nega e para (I-19). O leitor aplica **bloqueio duro próprio** via `isCriticalPath` no realpath, independente do modo (`bypass` incluído); `CRITICAL_PATHS`/ADR-0027 é pré-requisito de implementação. Anexo só nasce de superfície humana (editor, `/attach`, `/paste`, drag-drop); nunca de saída de modelo, payload de tool, plugin, skill ou subagente (I-01/I-02).

**Imagem e redação.** `redactSecrets` só cobre texto; imagem não é redigível: exige confirmação explícita, não persiste bytes no session store/export (só hash/metadados) e o prompt usa os bytes. Antes de decodificar, ler header (IHDR/SOF), cap de 25 MPx e 8192 px no lado maior + 20 MiB decodificados; `attachments.image.autoResize` (default false) redimensiona para 2048 px no lado maior, preservando proporção; rejeitar antes da alocação. Provider sem `vision` rejeita a imagem antes do envio.

**Limites e ordem.** Pipeline: canonicalizar → aplicar `range` (`end` além do EOF clampa; `start > end` é erro) → redigir → medir UTF-8 do conteúdo final. Texto 20 MiB/anexo; imagem 20 MiB decodificada; listagem de diretório conta no cap de texto; **40 MiB combinados por turno** (texto+imagem). O cap efetivo é `min(cap, orçamento de tokens do turno)`; um pré-check rejeita o turno **antes do request** com mensagem em português. O `guardContext` atual só descarta turnos antigos; não é o backstop do anexo e não há compactação silenciosa (ADR-0015/0023).

**Conteúdo e ledger.** O ledger grava só metadados/referência (`name`, `mediaType`, `bytes`, hash, `range`, classe do path, `ref`); nunca o conteúdo. O conteúdo fica no prompt do turno e, quando persistido, no session store (cap/sanitize, ADR-0010/0021) ou em artefato com `ref`. `usage` continua por chamada; anexo não cria entrada de custo separada. Conteúdo de arquivo/clipboard é **dado não confiável** (prompt injection), nunca instrução; `redactSecrets` roda antes do prompt/session store/artefato.

**Diretório e bordas.** Não recursivo, até 500 entradas (arquivos+diretórios+ocultos); acima pede filtro. Lista mostra nome+tamanho, exclui hard-block e `.astro`/`.git`; ocultos só com opt-in; a listagem conta no cap. `/attach` usa seletor fuzzy interno (zero deps); diálogos nativos são plugin opcional; `/paste` cola o clipboard como anexo; `Ctrl+V` de texto fica no prompt; imagem do clipboard adiada. Dedupe por path+range conta uma vez; remoção antes do envio é permitida; 0 byte texto aceito, 0 byte imagem rejeitado; binário fora do whitelist é rejeitado, não vira texto; SVG é texto; `#` só vira range se o sufixo casar `^\d+-\d+$` e o path sem sufixo existir.

## Consequências

- Ganho: entrada multimodal tipada, limites/testes claros e path/segredo sob a política existente.
- Custo: `/attach`/`/paste` na TUI, limites e confirmação canônica de path; imagem de clipboard adiada.
- Invariantes afetadas: I-03 (redação), I-11 (path), I-01/I-02 (escopo); I-12 só confirma que anexo não é tool.

**Dependência:** a implementação do bloqueio duro de anexo fica bloqueada até ADR-0027 (hard-block) entrar.

## Alternativas descartadas

- `@path` anexando conteúdo sem gate: bypass de allowlist/permissão.
- Anexo como tool call: muda o contrato de tool e o custo.
- Path fora do cwd sem confirmação canônica: quebra I-11.
- Ledger com conteúdo do anexo: viola I-03 e infla o log.
- Cap só em bytes sem contexto: aceita anexo que nunca caberia na janela.
- Redigir imagem: `redactSecrets` é textual; falso controle.
