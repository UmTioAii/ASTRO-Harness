# ADR-0031: shell em `auto` - Docker quando disponível, host com aprovação

- Status: aceita
- Data: 2026-11-20
- Issue: #474
- Decisões relacionadas: D-24, I-03, I-11, I-19, ADR-0027

## Contexto

`run_command` só executava em container Docker (ADR-0027) e `sandbox: false` desligava o shell por completo. Em máquina sem Docker o shell ficava inutilizável, mesmo com o usuário disposto a aprovar cada comando. A issue #474 pede um modo `"auto"`: usar o sandbox quando existir e, quando não existir, o host com aprovação por comando.

## Decisão

`tools.run_command.sandbox` aceita três valores; o **default é `"auto"`** (ausente = `"auto"`, e `astro.config.example.json` documenta o valor):

- `"auto"` (default): **Docker quando disponível**; sem Docker, **host com aprovação por comando**.
- `true`/`"docker"`: **só Docker**; sem Docker recusa (`sandbox_required_for_shell`), sem fallback.
- `false`: shell desligado (I-19).

Docker continua sendo o caminho preferido e o recomendado para repositório não confiável; o host é o fallback que mantém o shell utilizável sem daemon.

Todo comando no host passa por: allowlist/ceiling e gate de permissão do executor (o prompt mostra o comando, sem reutilizar grant de sessão), hard-block de path sobre os tokens path-like (I-11), env sanitizado (`secrets.ts`), redação ANTES do truncamento (I-03) e audit `host_shell.decision` só com decisão/modo/shell - nunca comando ou saída. O host só executa atrás do `ToolExecutor`; chamada direta recusa `host_shell_requires_gate`. Em `bypass` o host recusa com `host_shell_confirmation_required` salvo `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1`, porque `bypass` não abre prompt.

`shell.default` (gravado por `/shell` após `confirm`) só vale se o shell existir na máquina; ausente = `shell_not_available`, sem troca silenciosa. O projeto pode endurecer o global (Docker ou desligado), nunca reabrir o host com `"auto"` quando o global força Docker; `"auto"` herdado do global permanece `"auto"` se o projeto não declarar nada. `run_tests` mantém a regra própria: exige Docker explícito.

## Consequências

- Ganho: shell utilizável com ou sem Docker; Docker é preferido quando existe e pode ser forçado por config.
- O que o host **perde** em relação ao Docker: isolamento de rede (`--network none`), rootfs read-only, máscaras `:ro` de `.git`/hard-blocks, `HOME=/tmp` e neutralização de git. O comando vê o FS e a rede do usuário e pode alcançar processos/credenciais fora do alcance das tools; o hard-block só casa tokens literais, então expansão como `$HOME/.astro/...` não é pega lexicalmente.
- O que **compensa**: aprovação por comando com o comando no prompt, allowlist/ceiling, hard-block no dispatch, env sanitizado, redação antes do truncamento, audit sem saída e confirmação extra em `bypass`. Não é equivalente ao Docker: use `sandbox: true` em repositório não confiável.
- Invariantes afetados: I-11 (Docker é preferido, host é fallback), I-03, I-19.

## Alternativas descartadas

- Host sempre: ignora o Docker disponível e perde o isolamento sem necessidade.
- Docker como default: falha em máquina sem daemon e mantém o shell inutilizável.
- `sandbox: false` como host: silencioso e sem prompt por comando; mantido como shell desligado.
- Auto-aprovar em `bypass`: comando arbitrário sem revisão humana.
