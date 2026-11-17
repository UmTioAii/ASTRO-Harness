# Doctor

Diagnóstico local do ASTRO: versões, dependências, config, credenciais por nome e estado de disco; `--online` acrescenta o health dos providers (F6-6).

| Cobre | Não cobre |
|---|---|
| `astro doctor [--json] [--fix] [--online]`, checks e formato do JSON | Corrigir config, credenciais ou rede por conta própria |

## Comando

```bash
astro doctor                  # offline, determinístico, sem rede
astro doctor --json           # payload doctor/v1 para scripts e CI
astro doctor --fix            # cria só $ASTRO_HOME (0700), idempotente
astro doctor --online         # + health F6-6 dos providers
astro doctor --json --online  # combina os dois
```

| Flag | Efeito |
|---|---|
| `--json` | Emite só o payload JSON (uma linha por check fica de fora). |
| `--fix` | Cria `$ASTRO_HOME` quando ausente; nunca cria a raiz de artefatos e recusa caminho relativo, com `..`, link simbólico ou que seja arquivo. |
| `--online` | Roda `runHealthCheck` (F6-6): um check por provider e um agregado `online`. Sem a flag nenhuma chamada de rede acontece. |

## Checks offline

| Check | Fonte |
|---|---|
| `bun`, `node` | versão em execução × `engines` do `package.json` |
| `dependências` | resolução de `ink`, `react` e `bun` |
| `dist` | `dist/cli.js` e `dist/launcher.js` |
| `config`, `config global` | `astro.config.json` e `$ASTRO_HOME/config.json` |
| `credencial <provider>` | `credentialRef` por nome, cofre local ou `credentialsPath` legível |
| `mcp`, `skills` | config MCP (só nomes de env) e loader de skills |
| `astro home`, `anexos`, `disco` | existência, escrita e espaço livre |

Nenhum valor de segredo entra na saída: label e detalhe passam por `redactSecrets` (I-03).

## `--online`

O health usa o mesmo caminho de `astro health`: `GET {baseUrl}/models` com a credencial do ambiente, `redirect: "error"` e timeout de 5s por provider. Cada `HealthCheck` vira um check do doctor:

| Health | Doctor |
|---|---|
| `provider:<id>` `ok` | `ok`, com latência no detalhe |
| `provider:<id>` `down` | `error` (`fail` no alias legado) |
| agregado `online` | `error` se algum provider caiu, senão segue `ok`/`warn` do health |

Config ausente vira `ok` ("nada para verificar"); config inválida vira `warn`. Falha inesperada do health vira um check `online` `error`, nunca exceção. O timeout é por provider; uma rede lenta não trava os outros checks.

## Payload `--json`

```json
{
  "schema": "doctor/v1",
  "checks": [
    {
      "name": "bun",
      "status": "error",
      "message": "1.3.9 abaixo do mínimo >=1.4.0",
      "level": "fail",
      "label": "bun",
      "detail": "1.3.9 abaixo do mínimo >=1.4.0"
    }
  ],
  "summary": { "ok": 0, "warn": 0, "fail": 1 },
  "fixes": { "applied": [], "errors": [] }
}
```

| Campo | Contrato |
|---|---|
| `name` | identificador estável do check (`bun`, `config`, `provider:<id>`, `online`) |
| `status` | `ok`, `warn` ou `error` (#61) |
| `message` | detalhe legível; vazio quando o check não tem detalhe |
| `level`, `label`, `detail` | aliases legados de `status`, `name`, `message`; `error` aparece como `fail` |
| `summary` | contagem por `level`, na ordem `ok`, `warn`, `fail` |
| `fixes` | só com `--fix`; `applied` e `errors` redigidos |

Exit code: `0` quando não há `fail`; `1` quando algum check falha (inclusive provider fora em `--online`) ou quando `--fix` registra erro.

Referências: I-03, #61, F6-6.
