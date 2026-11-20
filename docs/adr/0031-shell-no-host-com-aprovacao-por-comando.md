# ADR-0031: shell no host com aprovação por comando

- Status: aceita
- Data: 2026-11-20
- Issue: #474
- Decisões relacionadas: D-24, I-03, I-11, I-19, ADR-0027

## Contexto

`run_command` só executava em container Docker (ADR-0027) e `sandbox: false` desligava o shell por completo. Em máquina sem Docker o shell ficava inutilizável, mesmo com o usuário disposto a aprovar cada comando, e `astro.config.example.json` ainda ensinava `"sandbox": false` - forma que só desligava a tool.

## Decisão

`tools.run_command.sandbox` aceita três valores: `true`/ausente (default) = só Docker, comportamento anterior; `"auto"` = Docker quando disponível, senão **host com aprovação por comando**; `false` = shell desligado (I-19). O host é opt-in explícito; Docker continua o default e a recomendação.

No caminho do host, o comando passa por: allowlist/ceiling e gate de permissão do executor (o prompt mostra o comando), hard-block de path sobre os tokens path-like do comando (I-11), env sanitizado (`secrets.ts`), redação ANTES do truncamento (I-03) e audit `host_shell.decision` só com decisão/modo/shell, nunca comando ou saída.

Regras próprias do host: `shell` não reutiliza grant de sessão no modo `auto` - cada comando pede aprovação de novo; em `bypass` o host recusa com `host_shell_confirmation_required` salvo `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1`, porque `bypass` não abre prompt e sem essa confirmação o comando rodaria sem nenhuma revisão humana. `shell.default` (gravado por `/shell` após `confirm`) só vale se o shell existir na máquina; ausente = `shell_not_available`, sem troca silenciosa.

## Consequências

- Ganho: shell utilizável sem Docker, com escopo por comando e rastro de auditoria; Docker segue intacto byte a byte.
- Perda no host (sem compensação): isolamento de rede (`--network none`), rootfs read-only, máscaras `:ro` de `.git`/hard-blocks, `HOME=/tmp` e neutralização de git. O comando vê o FS e a rede do usuário e pode alcançar processos/credenciais fora do alcance das tools.
- Compensa parcialmente: allowlist, aprovação por comando, hard-block no dispatch, env sem nomes de segredo, redação e audit sem saída. Não é equivalente ao Docker; por isso o host nunca é default.
- Invariantes afetados: I-11 (sandbox deixa de ser o único modo, mas continua default), I-03, I-19.

## Alternativas descartadas

- Manter `sandbox: false` como host: silencioso e sem prompt por comando; mantido como shell desligado.
- Host como default sem Docker: amplia o raio de dano sem ato explícito do usuário.
- Auto-aprovar em `bypass`: comando arbitrário sem revisão humana.
