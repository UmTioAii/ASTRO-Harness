# ADR-0028: config — versionamento semver, compatibilidade e migração

- Status: aceita
- Data: 2026-11-05
- Issue: #386
- Decisões relacionadas: ADR-0002, ADR-0019, ADR-0023, ADR-0026, ADR-0027, D-24, I-03

## Contexto

`astro.config.json` é config de projeto. `version` é validado como `x.y.z` quando presente, mas não participa de nenhuma decisão de compatibilidade, e chave desconhecida no **topo** é ignorada em silêncio (seções conhecidas já rejeitam). Resultado: config escrito para harness novo roda em harness antigo com ajustes perdidos, e um typo de chave passa despercebido. O ADR-0023 delega a política de migração/deprecação para cá; o ADR-0026/0027 delegam aqui o schema das chaves novas.

## Decisão

**Versão.** `version` é a versão do **schema do documento de config**, semver `x.y.z`, independente da versão do harness em `package.json`. Ausente = `0.0.0` (legado), aceito, e o `doctor` sugere declarar. O harness declara `CONFIG_SCHEMA_MAJOR` (alvo 1 nesta decisão).

**Semântica.** major: remove, renomeia ou redefine tipo/default de forma que muda comportamento; minor: chave ou valor novo opcional, retrocompatível; patch: só correção de validação/mensagem, sem mudança de forma. Chave nova entra em `src/config.ts` no mesmo PR do comportamento, com validação, teste e nota do minor.

**Matriz de compatibilidade.**

| config | resultado |
|---|---|
| major == suportado | aceita |
| major < suportado | migra em memória, um major por passo (`migrateVnToN+1` puro, cadeia testada por passo); sem caminho → `config_migration_required` cita o major e `astro config migrate` |
| major > suportado | recusa `config_ahead_of_harness`, mensagem manda atualizar o harness; nunca adivinha |
| ausente (`0.0.0`) | tratado como major 0 e migrado para o suportado em memória |

**Chaves desconhecidas.** No topo, chave desconhecida é `config_unknown_key` (erro), exceto `$schema`. Em seção conhecida continua erro. Forward-compat é responsabilidade da versão, nunca de ignorar chave: ignorar transforma config de harness novo em perda silenciosa.

**Migração.** O default é em memória, sem escrever no arquivo. `astro config migrate [--config <path>]` roda a cadeia completa, valida o resultado e grava atômico (temp + rename no mesmo diretório) **só então** atualiza `version`; validação falha deixa o arquivo intacto. O arquivo só migra se todas as chaves forem conhecidas no major de destino; caso contrário recusa e aponta a chave.

**Deprecação.** Chave marcada `@deprecated` no schema continua válida no minor em que é anunciada, emite aviso uma vez por load e no `doctor`; remoção só no próximo major, com entrada no `CHANGELOG`. Mudança de default conta como major, mesmo sem remover chave.

**Escopo.** Só `astro.config.json` (inclusive via `--config`). Stores de usuário (`providers.json`, `trusted.json`, `vault.json`, flags de segurança) têm formato próprio e ficam fora; se ganharem versão, ADR próprio. Dado persistido continua com inteiro (ADR-0002), não semver.

**Erros.** `config_ahead_of_harness`, `config_migration_required`, `config_unknown_key` e a validação de `version` são `ConfigError`, com mensagem em português citando chave/versão e nunca valor de segredo (I-03); recusa para o run (I-19).

## Consequências

- Ganho: config incompatível falha alto em vez de perder ajuste; typo visível; migração reprodutível e testável por passo.
- Custo: harness antigo passa a recusar config novo (intencional); `astro config migrate`; manutenção da cadeia de migração.
- Invariantes afetadas: I-03 (mensagem), I-19 (parada graciosa); I-11 não se aplica (config é path do usuário).

## Alternativas descartadas

- Ignorar chave desconhecida (status quo): perda silenciosa de configuração.
- `schemaVersion` inteiro no config: perde a compatibilidade aditiva que o config já usa; inteiro fica para dado persistido (ADR-0002).
- Migrar gravando sempre no load: escrita surpresa em arquivo versionado.
- Aceitar config mais novo com aviso: comportamento indefinido por chave.
- Versão por seção: multiplica majors e não resolve a compatibilidade do documento.
