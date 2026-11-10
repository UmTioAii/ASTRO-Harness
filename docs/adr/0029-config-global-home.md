# ADR-0029: configuração global no home do ASTRO

- Status: aceita
- Data: 2026-11-06
- Issue: #401
- Decisões relacionadas: ADR-0019, ADR-0028, I-01, I-03, I-11, I-17

## Contexto

`astro.config.json` é configuração de projeto; providers e trust também precisam sobreviver entre projetos. Os stores legados separam esses dados em arquivos no home, sem uma precedência única para a configuração efetiva.

## Decisão

Use `$ASTRO_HOME` (default `~/.astro`) para `config.json`, `state.json` e `vault.json`. `config.json` contém preferências e providers sem valores secretos; `state.json` contém trust por caminho e marcadores de migração; `vault.json` continua sendo o único arquivo de valores secretos.

Resolva defaults < configuração global < configuração de projeto (`astro.config.json` ou `--config`) < flags/env. `--config` escolhe somente a camada de projeto. `--no-global-config` e `ASTRO_NO_GLOBAL_CONFIG=1` ignoram a camada global.

Mescle objetos em profundidade; arrays substituem, exceto `models`, unidos por `provider/id` com precedência do projeto; escalares substituem. Rejeite widening de tools, modo de permissões e budget declarado globalmente; o projeto também não pode mudar o host de um provider global herdando a credencial global, nem reutilizar em outro host uma referência de credencial declarada globalmente (config global ou `providers.json`): a referência é reservada pela camada global.

Importe `providers.json` e `trusted.json` uma única vez para os destinos novos, preservando os arquivos legados. Sem configuração nem dados legados, o carregamento não cria arquivos; a configuração só é criada por uma ação explícita confirmada.

Após migrar providers, `config.json` é a fonte de verdade também para o gerenciador de providers da TUI; `providers.json` permanece preservado e não recebe novas edições.

## Consequências

- Ganho: preferências de usuário são reutilizadas entre projetos com fronteira clara para trust e segredos.
- Custo: o loader deve validar as camadas antes de executar; projeto não pode relaxar políticas globais.
- Invariantes afetados: I-01, I-03, I-11 e I-17.

## Alternativas descartadas

- Usar apenas `astro.config.json`: repete preferências e não oferece estado global.
- Gravar configuração no primeiro start: cria estado sem consentimento explícito.
- Mover segredos para `config.json` ou `state.json`: viola I-03.
