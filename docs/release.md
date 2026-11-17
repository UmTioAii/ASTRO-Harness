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
| 5 | `npm config get "@umtioai:registry"` = `https://registry.npmjs.org/` (se `undefined`: `npm config set "@umtioai:registry" https://registry.npmjs.org/`); outro valor aborta | humano |
| 6 | Conta npm no escopo público, 2FA/`npm login` válidos, versão/tag/notas acordadas na issue | humano |

`@scope:registry` do `.npmrc` vence `--registry` e `publishConfig.registry`: com `name` divergente, um mapa errado (`@umtioaii:registry=https://npm.pkg.github.com`, um `i` a mais) publica fora do npmjs com exit 0; por isso publish, view, install e rollback fixam `--@umtioai:registry=https://registry.npmjs.org/`.

`export PKG=@umtioai/astro-harness` (= `npm pkg get name`). Escopo novo não é atualização: `npm view "$PKG" version` precisa responder no registry público.

## 2. Versão e notas

- `version` em `package.json` é a única fonte (`npm pkg get version`); `dist/` é gerado e não entra no git. Pré-release: `0.1.0-alpha.N` → `N+1`; base nova (`0.2.0-alpha.1`) só quando o milestone fecha; compatibilidade de config segue `ADR-0028`.
- Notas: não há `CHANGELOG.md`; o GitHub Release da tag é o registro. Agrupe por tipo (`feat`, `fix`, `docs`, `chore`) os PRs desde a tag anterior (`git log --oneline <tag-anterior>..HEAD`; sem tag, use `npm view <pkg> time.modified`) e destaque deprecações de config.
- Bump em PR `chore/release-<versão>` (só `package.json`), squash merge. A tag `v<versão>` aponta para o commit do merge na `main`, nunca para um commit local.

## 3. Gate de CI

Na cabeça da branch de release, em Git Bash/WSL (o loop é bash), com lockfile congelado:

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

Depois do merge, trabalhe na tag; §4–§8 no mesmo shell, sem worktree sujo:

```bash
git fetch --tags && git switch --detach "v$(npm pkg get version | tr -d '"')"
git describe --tags --exact-match   # v<versão>
git status --short                  # vazio
bun install --frozen-lockfile
npm pack --dry-run                  # lista: dist/, README.md, LICENSE, package.json
PACKDIR=$(mktemp -d) && npm pack --pack-destination "$PACKDIR"
TARBALL=$(ls "$PACKDIR"/*.tgz 2>/dev/null) && [ -n "$TARBALL" ] && [ "$(printf '%s\n' "$TARBALL" | wc -l)" -eq 1 ] || { echo "pack: esperava 1 .tgz"; exit 1; }
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
| modelos / credencial | `mock-model` / vazio (provider local, sem chave) |
| salvar → testar (`t`, enter) → ativar (enter) | `ok` com latência |

- Fora da TUI, `astro providers test mock` exige `astro.config.json` no diretório; `401/403` indica credencial, `outage`/`network_timeout` indica URL ou porta. Tela e `providers.json` nunca mostram segredo (`I-03`). Provider real: smoke manual de `docs/providers.md`.

## 6. Publicação

Publique o `.tgz` já testado, com a tag de pré-release:

```bash
npm publish "$TARBALL" --tag alpha "--@umtioai:registry=https://registry.npmjs.org/"
```

- `publishConfig.access: public` vem do `package.json`; não passe `--access` divergente. Publish de `.tgz` não roda hooks: valem o gate do §3 e o pack do §4.
- 2FA: deixe o npm pedir o código; não passe `--otp` (fica no histórico). Token por `NODE_AUTH_TOKEN` ou `npm login`, nunca no repositório (`I-03`).
- `--tag alpha` move só `alpha`; `latest` muda apenas por decisão explícita (§7). Se o publish falhar, incremente a versão; não a reutilize.

## 7. Verificação pós-publicação

```bash
npm view "$PKG" version dist-tags --json "--@umtioai:registry=https://registry.npmjs.org/"
TB=$(npm view "$PKG@alpha" dist.tarball "--@umtioai:registry=https://registry.npmjs.org/")
printf '%s\n' "$TB" | grep -q '^https://registry.npmjs.org/' || { echo "registry errado: $TB"; exit 1; }
TMP2=$(mktemp -d) && cd "$TMP2" && npm init -y >/dev/null
npm install "$PKG@alpha" "--@umtioai:registry=https://registry.npmjs.org/"
./node_modules/.bin/astro --help | grep -q "astro run" && echo "publish ok"
```

| Verificação | Esperado |
|---|---|
| `version`, `dist-tags.alpha`, `latest` e host do `dist.tarball` | versão publicada; `latest` inalterado ou movido por decisão da issue; host `registry.npmjs.org` |
| Instalação nova por `@alpha`; `--help` e TUI + mock | exit 0, comandos listados; §5 |
| GitHub Release `v<versão>` | tag no commit do merge, notas da §2 |

## 8. Rollback

| Quando | Ação |
|---|---|
| Antes do publish | feche o PR e apague a tag local/remota; nada foi publicado |
| Versão com defeito (inclui segredo) | revogue a credencial (`I-03`); publique a próxima versão com a correção, sem reescrever a existente; `npm unpublish` só em até 72 h, sem dependentes e com decisão do dono |
| Pré-release ou `latest` errado | `npm dist-tag add "$PKG@<boa>" alpha "--@umtioai:registry=https://registry.npmjs.org/"` (ou `latest`); se a versão ruim continua instalável, `npm deprecate "$PKG@<ruim>" "quebrada; use <boa>" "--@umtioai:registry=https://registry.npmjs.org/"` |

- `npm unpublish` é exceção: quebra instalações e o registry pode recusar. Prefira deprecate + versão corrigida; versão publicada não aceita sobrescrita. Ajuste o GitHub Release (pré-release/deprecado) e registre na issue.

## Referências

`#230` (gate), `docs/ci.md` (jobs e merge), `docs/workflow.md` (PR, tag e merge), `docs/providers.md` (provider, cofre e smoke manual), `README.md` (instalação), `package.json` (`name`, `version`, `files`, hooks), `ADR-0017`/`ADR-0018` (Bun empacotado e launcher), `ADR-0028` (compatibilidade de config).
