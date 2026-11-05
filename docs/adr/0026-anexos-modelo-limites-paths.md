# ADR-0026: anexos — modelo, limites, paths e redação

- Status: aceita
- Data: 2026-11-05
- Issue: #382
- Decisões relacionadas: ADR-0020, ADR-0023, ADR-0027 (a abrir), I-03, I-11

## Contexto

O harness hoje aceita prompt de texto e menções `@path`; não há modelo tipado de anexo, limites por turno nem política de path fora do cwd. O plano v3.0 precisa de anexos de texto/imagem/diretório sem abrir caminho para segredo, path fora do cwd ou prompt gigante.

## Decisão

**Modelo.** Anexo = `{kind: text|image|directory, path, name, sizeBytes, mediaType, range?}`. SVG entra como `text`; imagem tem `sizeBytes` decodificado; `range` é `{start,end}` de linhas para texto. Diretório não é recursivo; lista no máximo 500 entradas e acima pede filtro.

**Limites.** Texto: 20 MiB por anexo e 40 MiB por turno; imagem: 20 MiB decodificado por anexo e 40 MiB por turno; exceder rejeita com motivo, ou redimensiona se `auto_resize`. O limite é de bytes, não de tokens; o context guard do turno ainda rejeita/trunca o prompt final.

**Paths e redação.** O padrão é o cwd; path absoluto fora do cwd exige confirmação explícita com o path mostrado. `CRITICAL_PATHS` (ADR-0027) é bloqueado mesmo com confirmação. Todo conteúdo de anexo passa por `redactSecrets` antes de entrar no prompt/ledger; segredo nunca é anexado.

**Entrada.** `@path` no editor insere `@path` ou `@path#20-45` e anexa o texto; `/attach` abre seletor fuzzy interno (zero deps), com diálogos nativos como plugin opcional; `/paste` cola o clipboard como anexo; `Ctrl+V` de texto cola no prompt e só vira anexo com `/paste`; imagem do clipboard fica adiada; drag-and-drop só lê path se o terminal expuser, senão avisa.

**Anexo, menção e tool.** Anexo entra no prompt como conteúdo; menção `@path` entra como contexto textual; a tool `read` decide quando ler. O ledger registra o custo/token de cada forma separadamente; anexo não vira tool call.

## Consequências

- Ganho: entrada multimodal tipada, limites claros e path/segredo sob a política existente.
- Custo: `/attach`/`/paste` na TUI, limites e confirmação de path; imagem de clipboard adiada.
- Invariantes afetadas: I-03 (redação), I-11 (path), I-12 (tool não muda).

## Alternativas descartadas

- Anexar diretório recursivo: custo/token imprevisível.
- Path fora do cwd sem confirmação: quebra I-11.
- Anexo como tool call: muda o contrato de tool e o custo.
- Imagem de clipboard no v1: dependência de plataforma; fica para spike.
