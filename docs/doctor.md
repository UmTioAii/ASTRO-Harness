# Doctor

Diagnóstico local do ASTRO: versões, dependências, config, credenciais por nome e disco; `--online` acrescenta o health dos providers (F6-6) e a conexão de cada servidor MCP (C2).

| Cobre | Não cobre |
|---|---|
| `astro doctor [--json] [--fix] [--online]`, checks e formato do JSON | Corrigir config, credenciais ou rede por conta própria |

## Comando

| Flag | Efeito |
|---|---|
| nenhuma | Checks offline, determinísticos, sem rede. |
| `--json` | Emite só o payload JSON (uma linha por check fica de fora). |
| `--fix` | Cria `$ASTRO_HOME` quando ausente (0700); nunca cria a raiz de artefatos e recusa caminho relativo, com `..`, link simbólico ou que seja arquivo. |
| `--online` | Roda `runHealthCheck` (F6-6): um check por provider, o cofre (`vault`), um agregado `online` e uma sonda de conexão por servidor MCP habilitado. Sem a flag nenhuma conexão acontece. |

## Checks

| Check (exibição) | `name` |
|---|---|
| `bun`, `node` | `bun`, `node` |
| `dependências`, `dist` | `dependencies`, `dist` |
| `config`, `config global` | `config`, `configGlobal` |
| `credencial <id>` | `credential:<id>` |
| `mcp`, `skills` | `mcp`, `skills` |
| `mcp <nome>` (só `--online`) | `mcp:<nome>` |
| `astro home`, `anexos`, `disco` | `astroHome`, `attachments`, `disk` |

Segredo nunca entra na saída: `name`, label e detalhe passam por `redactSecrets` (I-03). `name` é slug estável; `label` é só exibição.

## Config efetiva e isolamento

O check offline `config` valida a camada de projeto e a config efetiva (global + projeto). A camada de projeto só pode estreitar a política global (ADR-0029, I-01). Se o merge for recusado, `config` vira `fail` com o motivo redigido e o check `anexos` não apresenta TTL ou teto como valores efetivos; a ausência de config usa os defaults documentados.

A ausência é determinada pelas camadas, não pela resolução de provider: `NoProviderError` não vale como config ausente. Quando não há provider, o doctor injeta um provider sintético de diagnóstico, sem persistência nem rede, para validar a config efetiva completa com o schema do runtime. Assim uma camada global presente e inválida (por exemplo, `permissions.mode`, `attachments.artifactTtlDays` ou uma tool desconhecida de agent nomeado) reprova com exit 1 em vez de virar `TTL 7d`/`1.0 GiB` (#523). O schema recusa tool desconhecida em agent nomeado; a allowlist nominal do agent principal depende do registry e continua validada no runtime.

A coleta aceita `projectCwd`, `configPath`, `projectSkillsRoot` e `userSkillsRoot` para testes isolarem o projeto e as skills. Na CLI, os defaults permanecem o cwd do processo, `<cwd>/astro.config.json`, `<cwd>/.astro/skills` e `~/.astro/skills` (#523). Caminho relativo de `configPath` e `projectSkillsRoot` resolve contra `projectCwd`; `userSkillsRoot` resolve contra o cwd do processo (mesma base do loader de skills).

## `--online`

O health usa o mesmo caminho de `astro health`: `GET {baseUrl}/models` com a credencial do ambiente, `redirect: "error"` e timeout de 5s por provider. Cada `HealthCheck` vira um check, mais o agregado:

| Health | Doctor | Nível |
|---|---|---|
| `provider:<id>` `ok` | `provider:<id>` | `ok`, com latência |
| `provider:<id>` `down` | `provider:<id>` | `error` (`fail` no alias) |
| `vault` | `vault` (label `cofre`) | `ok`; só metadados |
| agregado | `online` | `ok` ou `error` |

`degraded`/`down` do health só existem com provider fora, e ambos viram `error`: o agregado `online` nunca é `warn` e `degraded` (ex.: credencial ausente) sai com exit 1.

`--online` usa `loadEffectiveConfig`: camada global (`$ASTRO_HOME/config.json`) e profile do ambiente contam. Se nenhum provider sobrar, `online` vira `ok` sem rede; config de projeto inválida vira `warn`; falha inesperada vira `online` `error`, nunca exceção.

## `--online`: MCP (C2)

Cada servidor MCP **habilitado** da config efetiva vira um check `mcp:<nome>` (label `mcp <nome>`), usando o mesmo `MCPClient.connect` do runtime: só o handshake `initialize` roda (sem `tools/list`). O orçamento é de 5s por servidor — ou o `timeoutMs` do próprio servidor, quando menor — e é aplicado **no transporte** (`min(server.timeoutMs, 5s)`), não só na corrida externa: sem isso um servidor travado seguraria o processo pelos 30s da config. `timeoutMs` é um knob só para `--online` (health do provider e sonda MCP); os dois usam 5s por padrão, então um segundo parâmetro não teria uso. As sondas rodam em paralelo; ao terminar, o cliente é fechado.

| Situação | Nível | Motivo |
|---|---|---|
| handshake `initialize` ok | `ok` | cliente fechado logo depois, mesmo se `close()` lançar |
| recusa, erro de processo ou timeout | `error` | motivo na mensagem, nunca exceção; cliente tardio é fechado |
| `enabled: false` | sem check | nenhuma conexão é feita e nada é reportado |
| config ausente, inválida ou sem provider ativo | sem check | sem lista validada de servidores; `online` já reporta o motivo |
| falha inesperada da própria sonda | `mcp:probe` `error` | slug próprio, para não colidir com o agregado offline `mcp` |

Transporte fora de `stdio`/`sse`/`http` não passa de `validateMcpServers`; a sonda repete a checagem como defesa em profundidade e falha fechado com `error`. A mensagem nunca ecoa credencial: os valores do servidor (header `env:NOME` já resolvido e cada valor de `env`) são trocados por `[REDACTED]` **antes** de `redactSecrets`, e qualquer URL vira `[url]` — servidor hostil que devolve `Authorization: <token>` não vaza no `--json` nem em log (I-03). O conector é injetável (`mcpConnect`) para teste não abrir socket.

## Payload `--json`

```json
{
  "schema": "doctor/v1",
  "checks": [{ "name": "bun", "status": "error", "message": "1.3.9 abaixo do mínimo >=1.4.0", "level": "fail", "label": "bun" }],
  "summary": { "ok": 0, "warn": 0, "fail": 1 }
}
```

| Campo | Contrato |
|---|---|
| `name` | slug estável: `bun`, `node`, `dependencies`, `dist`, `config`, `configGlobal`, `astroHome`, `attachments`, `skills`, `disk`, `mcp`, `mcp:<nome>`, `mcp:probe`, `credential:<id>`, `provider:<id>`, `vault`, `online` |
| `status` | `ok`, `warn` ou `error` (#61) |
| `message` | detalhe legível; vazio sem detalhe |
| `label` | exibição; pode mudar sem quebrar scripts |
| `level`, `detail` | aliases de `status`, `message`; `error` aparece como `fail` |
| `summary` | contagem por `level`: `ok`, `warn`, `fail` |
| `fixes` | só com `--fix`; `applied`/`errors` redigidos |

Exit code: `0` sem `fail`; `1` com algum check falho (inclusive provider fora ou servidor MCP inacessível) ou erro de `--fix`.

Referências: I-03, #61, C2, F6-6.
