# S1b — Setup wizard (primeira execução)

> Objetivo: a primeira execução cria toda a config, uma vez, por camada, sem escrever nada em silêncio nem travar máquina sem TTY.

- Status: draft (alpha.5, phase P0)
- Date: 2026-11-21
- ADR: nenhum novo; segue ADR-0028 (camadas e precedência) e ADR-0033 (perfil)
- Depends on: S1 (#594, perfil e limites)
- Owner files: `src/tui/run.tsx`, `src/core/config.ts`, `src/chat/provider-wizard.ts`,
  `src/tui/provider-screen.tsx`

## 1. Contrato

O wizard é o **único** caminho que cria config na primeira execução. Nenhum outro passo
grava config em silêncio. Ele roda sempre que a camada ainda não existe, e nunca sobrescreve
uma camada existente.

## 2. Quando roda, por camada

| Estado | O que acontece |
|---|---|
| sem config global **e** sem config de projeto | wizard completo |
| global existe, projeto não | mini-setup do projeto (perfil + pasta confiável), reaproveitando providers do global |
| projeto existe | não roda; nunca sobrescreve |

## 3. Fluxos

**Completo:** termos → perfil → provider → modelo → chave → TUI.

**Curto** (provider veio do ambiente): termos → perfil → TUI, com a linha
*"usando `<provider>` de `$OPENROUTER_API_KEY` — trocar?"* e uma tecla para cair no fluxo
completo.

**Precedência entre variáveis:** a ordem do catálogo, e o wizard sempre diz qual escolheu.
Nunca escolhe silenciosamente entre duas.

## 4. Sem TTY

Sem TTY (CI, pipe, `astro run` em script) não pergunta nada: uma linha de aviso, defaults em
memória, **nenhuma escrita**. `astro setup` reabre o wizard; `--yes` aceita os defaults num
terminal.

## 5. O que cada camada ganha

| Camada | Conteúdo |
|---|---|
| global (`$ASTRO_HOME/config.json`) | providers, modelos e `credentialRef` |
| projeto (`astro.config.json`) | `preset` e o modelo escolhido |
| chave | cofre (DPAPI no Windows, arquivo `0600` no POSIX) ou `credentialRef` para ambiente — **nunca** no config, em nenhuma das duas camadas (I-03) |

## 6. Integração obrigatória

- O wizard absorve o `ensureFirstRunConfig` (#559) e roda na mesma posição do portão dos
  termos (`src/tui/run.tsx:212`, antes de `ensureFirstRun()`). Se rodar depois, nunca verá
  "sem config" — outro passo já criou.
- **Não criar um terceiro fluxo de provider.** Já existem dois: o wizard linear de
  `/provider add|edit` (`src/chat/provider-wizard.ts`, usado pelo REPL) e a tela cheia da TUI
  (`src/tui/provider-screen.tsx`). O setup **reusa** o primeiro, e o segundo passa a chamá-lo.

## 7. Aceite

- [ ] Primeira execução sem config global nem de projeto abre o wizard completo, nessa ordem.
- [ ] O wizard absorve `ensureFirstRunConfig` (#559) e roda antes de `ensureFirstRun()`, na
      posição do portão dos termos.
- [ ] Global presente e projeto ausente abre só o mini-setup e não toca no global.
- [ ] Projeto presente não abre wizard nem sobrescreve nada.
- [ ] Sem TTY: nenhuma pergunta, nenhuma escrita, uma linha de aviso, defaults em memória.
- [ ] `astro setup` reabre o wizard; `--yes` aceita os defaults num terminal.
- [ ] Provider vindo do ambiente gera o fluxo curto e a opção de trocar.
- [ ] Nenhuma chave aparece em `astro.config.json`, no global, em log ou em audit (I-03).
- [ ] A tela cheia da TUI chama o wizard existente; não existe uma terceira implementação.

## 8. Fora de escopo

Novo catálogo de modelos (S3), TUIX (S5), limites de turno (S1), providers novos.
