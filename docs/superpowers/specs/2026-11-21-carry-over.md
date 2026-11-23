# P6 — Carry-over verificado

> Objetivo: fechar os quatro gaps de segurança e CI que a auditoria confirmou e que não pertencem a nenhuma fase de produto.

- Status: draft (alpha.5, phase P6)
- Date: 2026-11-21
- ADR: nenhum novo; aplica I-03, I-04 e D-02
- Depends on: S7 (#604)
- Owner files: `src/vault.ts`, `src/sanitize-external.ts`, `.github/workflows/`

## 1. Itens

| Item | Problema | Correção | Aceite |
|---|---|---|---|
| Lock do cofre | `src/vault.ts` faz read-modify-write sem lock; dois processos podem perder uma chave | usar `withFileLock` (já usado em `audit`, `ledger` e `agent-lock`) em toda escrita do cofre | dois processos gravando em paralelo preservam as duas chaves; teste com dois writers |
| Redação por espaço | `src/sanitize-external.ts:54` redige o valor só até o primeiro espaço, deixando o resto visível | redigir o valor inteiro, com teste de valor com espaço e de valor com quebra de linha | nenhum fragmento do valor sobrevive à sanitização |
| `powershell` pelo PATH | `src/vault.ts:76` resolve `powershell` pelo PATH, permitindo sequestro por binário plantado | resolver por caminho absoluto do sistema ou recusar quando não encontrado | um `powershell.exe` no `cwd` não é executado |
| CI incompleto | workflow não roda em tag nem executa `bun audit` | job para tag de release e passo `bun audit` bloqueante | push de tag executa a suíte; vulnerabilidade conhecida reprova o CI |

## 2. Regras

- Cada item entra com teste RED próprio; nenhum é corrigido "de passagem".
- Nenhuma correção pode gravar segredo em log, audit ou mensagem de erro (I-03).
- O lock novo não pode transformar uma falha de escrita em perda silenciosa: erro sobe
  classificado.

## 3. Aceite da fase

- [ ] Os quatro itens têm teste que falha antes e passa depois.
- [ ] `bun test` e `bun run typecheck` verdes nos dois SOs.
- [ ] CI executa em tag e `bun audit` reprova vulnerabilidade conhecida.
- [ ] `docs/security-threat-matrix.md` atualizado se algum vetor mudar de status.

## 4. Fora de escopo

Novos vetores de ataque, revisão completa do cofre, dependências de runtime.
