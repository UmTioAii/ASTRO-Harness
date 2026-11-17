# Release npm

Objetivo: publicar `@umtioai/astro-harness` (gate em #230), do bump à verificação pós-publicação e ao rollback.

| Cobre | Não cobre |
|---|---|
| Versão, notas, gate de CI, pack, instalação limpa, TUI com provider mock, publish, verificação, rollback | Merge (`docs/ci.md`), instalação do usuário (`README.md`), credenciais e cofre (`docs/providers.md`) |

## 1. Pré-requisitos

| # | Condição | Dono |
|---|---|---|
| 1 | Blocos 0–4 de #230 fechados; #58 e #138 fora do gate | #230 |
| 2 | `name` do `package.json` igual ao pacote publicado (mesma grafia de escopo) | `package.json` |
| 3 | `bun test` verde em 10 execuções consecutivas e `bun run typecheck` verde | §3 |
| 4 | CI do PR de release verde: `test` nos dois SOs, `eval` e `secrets` | `docs/ci.md` |
| 5 | Conta npm com permissão no escopo e no registry de destino, 2FA resolvida e `npm login` válido | humano |
| 6 | Versão, tag e notas acordadas na issue de release | humano |

Escopo novo não é atualização: publicar com `name` diferente cria outro pacote ou falha (`npm view @umtioai/astro-harness version` deve responder). Defina `export PKG=@umtioai/astro-harness` antes das seções 7 e 8.

## 2. Versão e notas

- `version` em `package.json` é a única fonte (`npm pkg get version`); `dist/` é gerado e não entra no git. Pré-release: `0.1.0-alpha.N` → `N+1`; base nova (`0.2.0-alpha.1`) só quando o milestone fecha; compatibilidade de config segue `ADR-0028`.
- Notas: não há `CHANGELOG.md`; o GitHub Release da tag é o registro. Agrupe por tipo (`feat`, `fix`, `docs`, `chore`) os PRs desde a tag anterior (`git log --oneline <tag-anterior>..HEAD`; sem tag, use `npm view <pkg> time.modified`) e destaque deprecações de config.
- Bump em PR `chore/release-<versão>` (só `package.json`), squash merge. A tag `v<versão>` aponta para o commit do merge na `main`, nunca para um commit local.

## 3. Gate de CI

Na cabeça da branch de release, com lockfile congelado:

```bash
bun install --frozen-lockfile
bun run typecheck
for i in $(seq 1 10); do bun test || { echo "falhou na execução $i"; break; }; done
bun run build
bun run smoke
```

- As 10 execuções são consecutivas e no mesmo commit; intermitência reprova o gate, não vira "verde com ressalva". Registre o resultado na issue.
- `smoke` reexecuta o build e valida `dist/launcher.js` com Node sem Bun no `PATH` (`scripts/smoke.ts`), incluindo `astro --help` e o help sem TTY.
- Os jobs de `docs/ci.md` rodam no PR de release e bloqueiam o merge como em qualquer PR.

## 4. Pacote e instalação limpa

Depois do merge, trabalhe na tag, não no worktree sujo:

```bash
git fetch --tags && git switch --detach "v$(npm pkg get version | tr -d '"')"
git describe --tags --exact-match   # v<versão>
git status --short                  # vazio
bun install --frozen-lockfile
npm pack --dry-run                  # lista: dist/, README.md, LICENSE, package.json
PACKDIR=$(mktemp -d) && npm pack --pack-destination "$PACKDIR"
TARBALL=$(ls "$PACKDIR"/*.tgz)
```

- `prepack` roda o build e `prepublishOnly` o typecheck; não use `--ignore-scripts`.
- O install baixa o runtime `bun` pinado (`ADR-0017`, `ADR-0018`); espere ~100 MB e exija rede.

Instalação limpa, sem config nem `ASTRO_HOME` do host:

```bash
TMP=$(mktemp -d) && cd "$TMP"
npm init -y >/dev/null
npm install "$TARBALL"
./node_modules/.bin/astro --help | grep -q "astro run" && echo "help ok"
```

- `--help` sai 0 e lista `astro run`; sem TTY, `astro` sem argumentos imprime o help. Windows/PowerShell: `.\node_modules\.bin\astro.cmd --help`.

## 5. TUI e provider mock

O gate exige a TUI abrindo e o wizard de provider concluindo sem credencial real. Salve `mock-openai.mjs` e suba um endpoint OpenAI-compatible local:

```js
// mock-openai.mjs — resposta fixa; nenhuma chamada externa
import { createServer } from "node:http";
createServer((req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"mock-model","object":"model"}]}');
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
  req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "mock", object: "chat.completion", model: "mock-model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })));
}).listen(8787, "127.0.0.1", () => console.log("mock: http://127.0.0.1:8787/v1"));
```

No diretório limpo do §4 (mesmo shell, terminal interativo):

```bash
node mock-openai.mjs &
mkdir -p "$TMP/astro-home" && export ASTRO_HOME="$TMP/astro-home"   # isola perfis e cofre
./node_modules/.bin/astro              # sem provider: abre a tela de providers
```

| Passo | Valor |
|---|---|
| adicionar (`a`) | `custom`, nome `mock` |
| base URL | `http://127.0.0.1:8787/v1` |
| modelos | `mock-model` |
| credencial | vazio (provider local, sem chave) |
| salvar → testar (`t`, enter) → ativar (enter) | `ok` com latência |

- Fora da TUI, `astro providers test mock` exige `astro.config.json` no diretório; `401/403` indica credencial, `outage`/`network_timeout` indica URL ou porta. Tela e `providers.json` nunca mostram segredo (`I-03`). Provider real: smoke manual de `docs/providers.md`.

## 6. Publicação

Publique o `.tgz` já testado, com a tag de pré-release:

```bash
npm publish "$TARBALL" --tag alpha
```

- `publishConfig.access: public` vem do `package.json`; não passe `--access` divergente. Publish de `.tgz` não roda hooks: valem o gate do §3 e o pack do §4.
- 2FA: `npm publish "$TARBALL" --tag alpha --otp <código>`. Token por `NODE_AUTH_TOKEN` ou `npm login`, nunca no repositório (`I-03`).
- `--tag alpha` move só `alpha`; `latest` muda apenas por decisão explícita (§7). Se o publish falhar, incremente a versão; não a reutilize.

## 7. Verificação pós-publicação

```bash
npm view "$PKG" version dist-tags --json
TMP2=$(mktemp -d) && cd "$TMP2" && npm init -y >/dev/null
npm install "$PKG@alpha"
./node_modules/.bin/astro --help | grep -q "astro run" && echo "publish ok"
```

| Verificação | Esperado |
|---|---|
| `version`, `dist-tags.alpha` e `latest` | versão publicada; `latest` inalterado ou movido por decisão da issue |
| Instalação nova por `@alpha` e `--help` | exit 0, comandos listados |
| TUI + provider mock | §5, com `ASTRO_HOME` novo |
| GitHub Release `v<versão>` | tag no commit do merge, notas da §2 |

## 8. Rollback

| Quando | Ação |
|---|---|
| Antes do publish | feche o PR e apague a tag local/remota; nada foi publicado |
| Versão publicada com defeito | publique a próxima versão com a correção; não reescreva a existente |
| Pré-release quebrada | `npm dist-tag add "$PKG@<anterior>" alpha` e `npm deprecate "$PKG@<ruim>" "quebrada; use <anterior>"` |
| `latest` errado | `npm dist-tag add "$PKG@<boa>" latest` |
| Segredo no pacote | revogue a credencial (`I-03`), deprecate a versão e publique a correção; `npm unpublish` só em até 72 h, sem dependentes e com decisão do dono |

- `npm unpublish` é exceção: quebra instalações e o registry pode recusar. Prefira deprecate + versão corrigida; versão publicada não aceita sobrescrita. Ajuste o GitHub Release (pré-release/deprecado) e registre na issue.

## Referências

`#230` (gate), `docs/ci.md` (jobs e merge), `docs/workflow.md` (PR, tag e merge), `docs/providers.md` (provider, cofre e smoke manual), `README.md` (instalação), `package.json` (`name`, `version`, `files`, hooks), `ADR-0017`/`ADR-0018` (Bun empacotado e launcher), `ADR-0028` (compatibilidade de config).
