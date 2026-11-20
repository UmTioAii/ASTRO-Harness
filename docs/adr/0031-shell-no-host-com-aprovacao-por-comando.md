# ADR-0031: shell no host por padrão, Docker como hardening opcional

- Status: aceita
- Data: 2026-11-20
- Issue: #474
- Decisões relacionadas: D-24, I-03, I-11, I-19, ADR-0027

## Contexto

`run_command` só executava em container Docker (ADR-0027) e `sandbox: false` desligava o shell por completo. Em máquina sem Docker o shell ficava inutilizável, mesmo com o usuário disposto a aprovar cada comando. O custo de operação do Docker (daemon, imagem, latência) também não se justifica quando o usuário já aprova comando a comando.

## Decisão

O **default é o shell no host**, com aprovação por comando. `tools.run_command.sandbox`: ausente e `"auto"` = host; `true`/`"docker"` = container Docker; `false` = shell desligado (I-19). Docker é o **hardening recomendado para repositório não confiável**, disponível por config, e não o default.

Todo comando no host passa por: allowlist/ceiling e gate de permissão do executor (o prompt mostra o comando, sem reutilizar grant de sessão), hard-block de path sobre os tokens path-like (I-11), env sanitizado (`secrets.ts`), redação ANTES do truncamento (I-03) e audit `host_shell.decision` só com decisão/modo/shell - nunca comando ou saída. O host só executa atrás do `ToolExecutor`; chamada direta recusa `host_shell_requires_gate`. Em `bypass` o host recusa com `host_shell_confirmation_required` salvo `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1`, porque `bypass` não abre prompt.

`shell.default` (gravado por `/shell` após `confirm`) só vale se o shell existir na máquina; ausente = `shell_not_available`, sem troca silenciosa. O projeto pode endurecer o global (Docker ou desligado), nunca voltar ao host quando o global força Docker. `run_tests` mantém a regra própria: exige Docker.

## Consequências

- Ganho: shell utilizável sem Docker, com escopo por comando e rastro de auditoria; Docker disponível como hardening.
- O que o host **perde** em relação ao Docker: isolamento de rede (`--network none`), rootfs read-only, máscaras `:ro` de `.git`/hard-blocks, `HOME=/tmp` e neutralização de git. O comando vê o FS e a rede do usuário e pode alcançar processos/credenciais fora do alcance das tools; o hard-block só casa tokens literais, então expansão como `$HOME/.astro/...` não é pega lexicalmente.
- O que **compensa**: aprovação por comando com o comando no prompt, allowlist/ceiling, hard-block no dispatch, env sanitizado, redação antes do truncamento, audit sem saída e confirmação extra em `bypass`. Não é equivalente ao Docker: use `sandbox: true` em repositório não confiável.
- Invariantes afetados: I-11 (Docker deixa de ser o default, mas segue recomendado), I-03, I-19.

## Alternativas descartadas

- Docker como default: falha em máquina sem daemon e mantém o shell inutilizável, contra o título da issue.
- `sandbox: false` como host: silencioso e sem prompt por comando; mantido como shell desligado.
- Auto-aprovar em `bypass`: comando arbitrário sem revisão humana.
