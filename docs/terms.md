# Termos de uso

Cinco linhas em português, mostradas uma vez por versão, com o aceite registrado em `$ASTRO_HOME/state.json` (#479).

| Cobre | Não cobre |
|---|---|
| Texto e versão, onde é perguntado, formato do registro e o caminho sem terminal | Política publicada na web, telemetria ou consentimento além dos termos (fora de escopo) |

## Texto (versão 1)

Normativo em `TERMS_LINES` (`src/terms.ts`); a lista abaixo é a cópia lida na revisão jurídica e o teste falha se divergir.

1. O ASTRO roda na sua máquina; a conversa não é enviada a servidores do projeto.
2. O conteúdo da conversa vai para o provider que você configurou e segue a política dele.
3. Ferramentas executam com as permissões que você concede; revise cada aprovação.
4. Tokens e chamadas de API são cobrados pelo provider, na sua conta.
5. O software é fornecido no estado em que está, sem garantia de resultado.

Sem rede: o texto vive no repositório e nunca é buscado. `TERMS_VERSION` sobe quando o texto muda e faz a próxima sessão interativa perguntar de novo.

## Onde aparece

| Superfície | Comportamento |
|---|---|
| `astro` (TUI) | primeiro run: mostra as cinco linhas e **só Enter (linha vazia) aceita**; qualquer outra resposta — inclusive espaço e EOF — recusa, imprime o motivo e sai 1 sem gravar config, sessão ou estado |
| `astro chat` com TTY | mesma pergunta, antes de qualquer escrita e do readline do REPL (`bootChat` em `src/chat/boot.ts`); recusa sai 1 sem abrir sessão |
| `astro chat` sem TTY (stdin em pipe, CI) | não pergunta: um aviso no stderr e a sessão segue, sem registrar aceite; o readline do REPL nasce depois do portão |
| `astro run`, `eval`, `bench`, `serve` | nunca consultam os termos: run não interativo nunca é bloqueado |
| `astro setup` | não pergunta os termos: comando explícito de configuração (como `config migrate`); grava a camada que faltar e, sem TTY, não pergunta nem grava |
| `/terms` (TUI e REPL) | texto completo, versão corrente e a data do aceite, ou "ainda não aceito"; `state.json` ilegível vira aviso que cita só o caminho e a sessão continua |

Um só readline por vez em `process.stdin`: o portão dos termos pergunta antes de o REPL/TUI criar o seu, porque dois `Interface` de terminal no mesmo stream disputam o mesmo chunk e o `close()` do portão pausa o stdin.

Sem canal interativo a escolha é **prosseguir com aviso**, não recusar: os termos são um registro de leitura, e recusar quebraria todo `run`/CI sem oferecer como aceitar. O aceite fica pendente até a primeira sessão interativa; enquanto isso `/terms` mostra o estado e a TUI pergunta.

## Registro

`$ASTRO_HOME/state.json` (estado, não configuração), ao lado de `trust` e `migrations`:

```json
{ "terms": { "version": "1", "acceptedAt": "2026-11-20T12:00:00.000Z" } }
```

| Campo | Regra |
|---|---|
| `version` | versão curta aceita (`TERMS_VERSION`); ausente = nunca aceito |
| `acceptedAt` | data ISO (`toISOString()`) do aceite |

- Só a versão e a data: nenhuma credencial, caminho, nome ou identificador de máquina.
- Escrita atômica (tmp + rename) com `0600`; diretório `0700` no POSIX — criado assim e, se já existia com outro modo, ajustado em melhor esforço (no Windows vale a ACL do perfil); `state.json` ausente ou sem `terms` continua válido.
- O aceite fica registrado só aqui: não gera linha de auditoria nesta versão — diferente de `trust.decision` (`src/trust.ts`), não há evento de aceite por decisão de escopo do #479.
- A mesma versão não pergunta de novo; a versão nova pergunta e substitui o registro. A recusa nunca escreve: um `state.json` existente fica byte a byte igual; o aceite preserva `trust` e `migrations`.
- Registro inválido (campo desconhecido, versão vazia, data fora do ISO) é erro que cita só o caminho, nunca o conteúdo.
- No boot, registro inválido encerra com erro (não dá para registrar um aceite confiável); no `/terms` o mesmo erro vira aviso e a sessão continua.

## Shell risk consent (#599)

The shell runs on the user's machine with the user's authority (ADR-0034), so the risk
is acknowledged once at the same gate as the terms. `SHELL_CONSENT_LINES`
(`src/shell-consent.ts`) is the normative text; the list below is its copy.

1. The shell runs on your machine with your authority, outside a container.
2. A model-requested command needs your approval unless a shell rule allows it.
3. The allowlist, the scanner and the hard-blocks are guardrails, not a guarantee.

| Surface | Behaviour |
|---|---|
| `astro` / `astro chat` with a TTY | after the terms, asks once per version; only Enter accepts |
| Decline | nothing is written and the shell stays off for the session; the next interactive start asks again |
| No TTY (`run`, `eval`, CI) | never asks and never writes; the per-command approval gate remains the control |
| `/terms` | shows the shell consent status next to the terms status |

Recorded in `$ASTRO_HOME/state.json` next to `terms`, with the same atomic write
(`0600`, directory `0700` on POSIX):

```json
{ "shell": { "version": "1", "acceptedAt": "2026-11-23T12:00:00.000Z" } }
```

Only version and date. The record itself is the audit trail: no event per acceptance,
the same scope choice as #479, while each shell decision emits `host_shell.decision`
with a command hash, effect and origin. Bumping `SHELL_CONSENT_VERSION` asks again.

## Pendências

- Revisão jurídica do texto acima é obrigatória antes de publicar (checklist do PR de #479).
- Revogar o aceite não tem comando: apagar o campo `terms` do `state.json` faz a TUI perguntar de novo.
