# Mapa da documentação

Objetivo: apontar o documento certo para cada tarefa.

| Cobre | Não cobre |
|---|---|
| Índice dos documentos de `docs/` | Conteúdo dos próprios documentos |

| Arquivo | Quando ler | Linhas |
|---|---|---|
| `AGENTS.md` | Sempre, no início de qualquer sessão | ~110 |
| `docs/CONTRIBUTING-DOCS.md` | Antes de escrever ou revisar qualquer documento | ~25 |
| `docs/implementation-guide.md` | **Primeiro doc ao implementar uma issue**: TDD, fluxo, revisão dupla, padrões de código | ~130 |
| `docs/workflow.md` | Ao abrir branch, commit ou PR (detalhe do fluxo) | ~90 |
| `docs/review-checklist.md` | Ao revisar um PR | ~50 |
| `docs/invariants.md` | Ao tocar em segredo, tool, caminho, custo, aprovação ou auditoria | ~50 |
| `docs/security-threat-matrix.md` | Ao avaliar ameaça, mitigação ou cobertura de segurança (I-01/I-03/I-11/I-15) | ~45 |
| `docs/decisions.md` | Ao precisar do motivo de uma escolha (D-xx) | ~100 |
| `docs/config-parity.md` | Ao decidir onde um ajuste mora, quem lê/grava, ou o que vence entre flag e valor salvo (D-31, D-CFG2/Q-10) | ~105 |
| `docs/astro-home-layout.md` | Ao mover skills, sessões ou estado da TUI, ou ao mexer na chave do projeto em `$ASTRO_HOME` (#468) | ~60 |
| `docs/adr/` | Decisão arquitetural nova ou revisão de uma antiga | 1 por arquivo |
| `docs/adr/0029-config-global-home.md` | Configuração global, precedência e migração de `$ASTRO_HOME` (#401) | S1 |
| `docs/adr/0030-presets-simple-control-e-nome-de-profile.md` | Presets Simple/Control e a fronteira entre `profile` e `preset` (#478) | ~45 |
| `docs/adr/0031-shell-no-host-com-aprovacao-por-comando.md` | `auto` como default do shell: Docker quando disponível, host com aprovação como fallback, e o que se perde sem Docker (#474); **superseded by ADR-0034** | ~35 |
| `docs/adr/0034-host-shell-default-consent-audit.md` | Host shell as the default path: ordered rules, scanner, approvals, risk consent and hashed audit (#599) | ~60 |
| `docs/adr/0033-turn-round-limits-and-profiles.md` | Turn/round limits, schema 2 aliases and Default/Control precedence (#594) | ~30 |
| `docs/adr/0035-tui-timeline.md` | Timeline contract shared by the pure renderer and turn events: entries, ordering, labels, redaction, width bands (#595) | ~45 |
| `docs/adr/0036-agents-handoff-and-resume-levels.md` | Agents, child handoff and the L1/L2/L3 resume levels (#602) | ~45 |
| `docs/adr/0037-per-account-concurrency-and-bounded-agents.md` | Per-account concurrency, bounded spawn and shared-account budget (#602) | ~45 |
| `docs/superpowers/plans/` | Ao executar uma frente do planejamento; roadmap de issues abertas em `2026-11-01-roadmap-execucao-issues-abertas.md` | 1 por frente |
| `docs/superpowers/specs/` | Antes de implementar uma frente aprovada; anexos em `2026-11-08-anexos-attachments-design.md` (#392) | 1 por frente |
| `docs/alpha.5-roadmap.md` | Ordem, dependências e decisões do pacote alpha.5 | ~290, exceção temporária registrada no próprio roadmap |
| `docs/superpowers/specs/2026-11-21-limits-and-profiles.md` | S1/P0: limites, schema 2.0.0 e perfis Default/Control | ~127 |
| `docs/superpowers/specs/2026-11-21-setup-wizard.md` | S1b/P0: setup da primeira execução por camada (#611) | ~78 |
| `docs/superpowers/specs/2026-11-21-host-shell.md` | S2/P0.5: shell no host, scanner e aprovações | ~124 |
| `docs/superpowers/specs/2026-11-21-turn-events.md` | S5a/P1: eventos ao vivo do turno e canal de raciocínio | ~78 |
| `docs/superpowers/specs/2026-11-21-tuix-design.md` | S5/P2: timeline TUIX em fluxo contínuo | ~140 |
| `docs/superpowers/specs/2026-11-21-model-catalog.md` | S3/P3: fatos, ofertas e overrides de modelos | ~85 |
| `docs/superpowers/specs/2026-11-21-agents-and-handoff.md` | S4/P4: agentes, concorrência e handoff | ~93 |
| `docs/superpowers/specs/2026-11-21-tools-contract.md` | S6/P5: contrato de saída das tools | ~44 |
| `docs/superpowers/specs/2026-11-21-web-tools.md` | S7/P5.5: busca, fetch, cache e citações | ~62 |
| `docs/superpowers/specs/2026-11-21-carry-over.md` | P6: fechamento dos quatro gaps de segurança e CI (#605) | ~42 |
| `docs/superpowers/specs/2026-11-21-docs-and-public-repo.md` | S8/P7: tradução, README e higiene do repositório | ~69 |
| `docs/roadmap.md` | Histórico das fases concluídas (F0–F7) | ~70 |
| `docs/roadmap-complementar.md` | Itens planejados das camadas 0–3 (F-xx, T, C, P) | ~120 |
| `docs/providers.md` | Ao construir provider, validar credencial ou usar os SDKs | ~90 |
| `docs/provider-cards.md` | Ao mover/editar model cards, adicionar um provider ou ler o contrato do card (#553) | ~45 |
| `docs/doctor.md` | Ao usar ou alterar `astro doctor`: checks, `--online` e formato `doctor/v1` (#61) | ~90 |
| `docs/tui-layout.md` | Ao mudar header, footer, erro, aviso ou progresso da TUI (#480) | ~116 |
| `docs/skills.md` | Ao criar, instalar, revisar ou invocar uma skill (`/<nome>`) | ~100 |
| `docs/ci.md` | Ao mexer em workflow, investigar falha de CI ou decidir merge | ~35 |
| `docs/eval.md` | Ao rodar `eval`/`bench`, ler success rate, filtro de provider/modelo ou agendamento de CI (`#59`) | ~70 |
| `docs/release.md` | Ao preparar, publicar ou reverter uma versão npm (#230) | ~150 |
| `docs/mcp.md` | Ao configurar servidores MCP, transports, reconexão ou modelo de confiança | ~60 |
| `docs/web-tools.md` | Ao configurar `webSearch` ou usar `web_search`/`search_and_read`/`web_fetch` | ~60 |
| `docs/todo-write.md` | Ao usar ou alterar `todo_write` (plano do run, F-17) | ~40 |
| `docs/run-tests.md` | Ao configurar `run.tests` ou usar/alterar `run_tests` (F-15, #538) | ~55 |
| `docs/tools-contract.md` | Ao criar/alterar uma tool: teto, marcador, redação e taxonomia de falha (#603) | ~55 |
| `docs/memory.md` | Ao usar ou alterar a memória persistida e `memory_write` (#532) | ~70 |
| `docs/terms.md` | Ao mexer no texto dos termos, no aceite por versão ou no registro em `state.json` (#479) | ~45 |

Referências usadas nos documentos:

- `D-xx`: decisão, em `docs/decisions.md`.
- `I-xx`: invariante, em `docs/invariants.md`.
- `ADR-NNNN`: decisão arquitetural, em `docs/adr/`.
- `#n`: issue ou PR no GitHub.
- `F0`–`F7`: fase concluída, em `docs/roadmap.md`.
- `F-xx`: item da Camada 0, em `docs/roadmap-complementar.md`.
- `T1`–`T4`, `C1`–`C7`, `P-01`–`P-04`: itens das camadas 1–3, em `docs/roadmap-complementar.md`.
