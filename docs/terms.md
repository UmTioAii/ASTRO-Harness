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
| `astro` (TUI) | primeiro run: mostra as cinco linhas e **Enter aceita**; qualquer outra resposta (ou EOF) recusa, imprime o motivo e sai 1 sem gravar config, sessão ou estado |
| `astro chat` com TTY | mesma pergunta; recusa sai 1 sem abrir sessão |
| `astro chat` sem TTY (stdin em pipe, CI) | não pergunta: um aviso no stderr e a sessão segue, sem registrar aceite |
| `astro run`, `eval`, `bench`, `serve` | nunca consultam os termos: run não interativo nunca é bloqueado |
| `/terms` (TUI e REPL) | texto completo, versão corrente e a data do aceite, ou "ainda não aceito" |

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
- Escrita atômica (tmp + rename) com `0600` e diretório `0700` no POSIX (vale a ACL do perfil no Windows); `state.json` ausente ou sem `terms` continua válido.
- A mesma versão não pergunta de novo; a versão nova pergunta e substitui o registro. A recusa nunca escreve: um `state.json` existente fica byte a byte igual.
- Registro inválido (campo desconhecido, versão vazia, data fora do ISO) é erro que cita só o caminho, nunca o conteúdo.

## Pendências

- Revisão jurídica do texto acima é obrigatória antes de publicar (checklist do PR de #479).
- Revogar o aceite não tem comando: apagar o campo `terms` do `state.json` faz a TUI perguntar de novo.
