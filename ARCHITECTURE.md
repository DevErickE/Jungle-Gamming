# Arquitetura

Este documento registra as decisões do serviço de transações de apostas, os trade-offs que aceitamos e o que ainda não está coberto.

## 1. Stack

| Tema | Escolha | Por quê |
| --- | --- | --- |
| Runtime | Bun 1.x | Exigido pela spec |
| Framework | NestJS | Exigido pela spec. Fica só na borda HTTP e na injeção de dependências. O domínio não importa nada dele |
| ORM | TypeORM 1.1 | Aceito pela spec. Usado para a conexão, as transações (`dataSource.transaction`) e as migrations. O acesso aos dados é SQL explícito, sem entidades. A spec prefere MikroORM, e a troca foi uma decisão do time. Ver a seção 1.1 |
| Banco | PostgreSQL 16 (testado em Docker com a 16 e localmente com a 18.4) | Constraints, `FOR UPDATE` e triggers seguram as invariantes |
| Mensageria | SQS, via LocalStack | Exigido pela spec. Implementado: consumidor, publicador da outbox, DLQ |

### 1.1 Por que TypeORM e não MikroORM

A spec prefere MikroORM e aceita TypeORM. Trocamos para TypeORM por decisão do time. Os recursos que motivaram a preferência da spec, Unit of Work e `LockMode`, não são usados aqui: as transações críticas são SQL escrito à mão, com `FOR UPDATE` e `SKIP LOCKED`, e nenhuma entidade é mapeada. O que o projeto usa do ORM é a conexão, o controle de transações e o gerenciamento das migrations. Esses recursos existem nos dois ORMs.

O que mudou na troca: `DataSource` no lugar de `MikroORM`, `dataSource.transaction` no lugar de `em.transactional`, `queryRunner.query` para executar SQL (com os `?` convertidos para `$1, $2`), e migrations que implementam `MigrationInterface`. O número de linhas afetadas vem de `queryRunner.query(sql, params, true)`.

**Atenção para o banco de desenvolvimento:** a tabela `schema_migrations` criada pelo MikroORM tem outro formato. Quem tinha o banco de desenvolvimento precisa recriá-lo para aplicar as migrations do TypeORM (ver o README). O banco de teste é recriado a cada execução.

## 2. Dinheiro

- **No domínio**, `Money` guarda o valor em centavos, como `bigint`. A aritmética é inteira, então não há erro de ponto flutuante.
- **Na entrada**, `amount` é uma string decimal de 1 a 2 casas. Rejeitamos sinal, notação científica, `NaN`, `Infinity`, string vazia e mais de duas casas. `"25.5"` vira `"25.50"`.
- **No banco**, `balance_minor` e `amount_minor` são `bigint`. O driver devolve `bigint` como string, então a conversão passa por `money-mapper.ts`.
- **Por que não `NUMERIC`:** com `bigint`, o domínio e o banco fazem a mesma conta, sem conversão no meio.
- **Multi-moeda:** o modelo aceita qualquer código ISO-4217. Operações entre moedas diferentes lançam `MONEY_CURRENCY_MISMATCH` no domínio, e as chaves compostas do banco barram o mesmo caso.

## 3. Modelo de domínio

- **`Money`** é imutável. Cada operação devolve uma instância nova.
- **`Wallet`** é o aggregate root. `debit` e `credit` validam moeda e valor positivo e geram exatamente um `WalletLedgerEntry` por movimento. Se a validação falha, o estado não muda.
- **`WalletLedgerEntry`** é imutável. A factory `create` confere a aritmética: saldo antes, mais ou menos o valor, igual ao saldo depois.
- **`transaction-rules.ts`** guarda as regras puras de cada tipo: quais tipos existem, quais referências cada um aceita, se o tipo é uma reversão e em que direção ele mexe no saldo. Não depende de banco.
- **Desvio do esqueleto da spec:** `Wallet.open` recebe `openingEntryId` e `openingTransactionId` e devolve `{ wallet, openingEntry }`. Assim o lançamento de abertura nasce junto com a wallet, e a versão começa em 1 com o saldo inicial, como no exemplo da seção 9.
- **A wallet não resolve concorrência sozinha.** Ela é um modelo em memória. Quem protege as instâncias entre si é a persistência (seção 5).

## 4. Schema e constraints

As migrations ficam em `src/infrastructure/persistence/migrations/`:

| Migration | O que faz |
| --- | --- |
| `Migration1793210400000` | Cria `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`, com constraints e triggers do ledger |
| `Migration1793214000000` | Adiciona `balance_observed_minor`, usada para o replay devolver o saldo da época |
| `Migration1793217600000` | Troca o índice de reversão: uma transação só pode ser revertida uma vez, por REFUND ou ROLLBACK |

O nome de cada classe termina com um timestamp de 13 dígitos, porque o TypeORM ordena as migrations por esse valor. A lista de migrations fica em `migrations/index.ts`. A tabela de controle é `schema_migrations`.

Invariantes garantidas pelo banco:

| Invariante | Como é garantida |
| --- | --- |
| Saldo nunca negativo | `CHECK (balance_minor >= 0)` em `wallets` |
| Uma wallet por jogador e moeda | `UNIQUE (player_id, currency)` |
| Idempotência persistente | `UNIQUE (provider_id, external_transaction_id)` e `UNIQUE (idempotency_key)` |
| Transação na wallet, jogador e moeda certos | Chave estrangeira composta `(wallet_id, player_id, currency)` |
| Referência na mesma wallet | Chave estrangeira composta `(reference_transaction_id, wallet_id)` |
| REFUND e ROLLBACK têm referência | `CHECK` em `wager_transactions` |
| REJECTED e FAILED têm `failure_code`; os outros não têm | `CHECK` |
| Uma reversão por transação, no total | Índice único parcial em `reference_transaction_id`, filtrado por REFUND ou ROLLBACK com status PENDING ou PROCESSED |
| Aritmética do lançamento | `CHECK` com direção e saldos antes e depois |
| No máximo um lançamento por transação e wallet | `UNIQUE (transaction_id, wallet_id)` |
| Sem dois lançamentos na mesma versão da wallet | `UNIQUE (wallet_id, wallet_version)` |
| Ledger imutável | Triggers que rejeitam `UPDATE`, `DELETE` e `TRUNCATE` com SQLSTATE `23001` |
| Inbox sem duplicata | Chave primária `(consumer_name, message_id)` |

**Migrations reversíveis.** `bun run db:migrate` aplica e `bun run db:migrate:down` desfaz a última. O teste de integração desfaz as três e aplica de novo.

## 5. Concorrência

A unidade de concorrência é a wallet.

**Estratégia: lock pessimista por linha.** Toda transação começa com `SELECT ... FOR UPDATE` na linha da wallet. Tudo o que depende de saldo ou de duplicidade acontece depois desse lock.

- **Lock por wallet, não global.** Wallets diferentes não se bloqueiam.
- **O lock vem antes da checagem de idempotência.** Um duplicado concorrente espera, lê a transação já confirmada e responde como replay. Assim não existe corrida entre "verificar" e "inserir".
- **Reversões concorrentes.** REFUND e ROLLBACK exigem que a referência esteja na mesma wallet, então reversões concorrentes da mesma transação disputam o mesmo lock. A segunda vê a primeira já confirmada e é rejeitada.
- **Por que não optimistic com retry.** Numa wallet quente, cada retry refaz o trabalho. O lock é mais previsível. O `WHERE version = ?` no `UPDATE` fica como uma segunda defesa.
- **Limitação.** Wallets muito quentes ficam serializadas. A spec aceita isso. O caminho seria sharding ou uma fila por wallet.

**Controle negativo.** Com o `FOR UPDATE` removido, quatro testes de concorrência falharam: o cenário 100/80+80, as 50 duplicatas, as wallets em paralelo e a disputa de 30 apostas. Com o lock, todos passam.

**Processos reais.** `test/integration/multi-process.test.ts` dispara três processos Bun contra a mesma wallet. Com saldo de 100.00 e 30 apostas de 5.00, exatamente 20 passam e o saldo final é 0.00.

## 6. Regras de negócio

As regras ficam em `SubmitWagerUseCase` (`src/application/wagering/submit-wager.use-case.ts`). As regras puras por tipo ficam em `transaction-rules.ts`.

| Tipo | Efeito no saldo | Referência | Regra principal |
| --- | --- | --- | --- |
| BET | Débito | Não aceita | Rejeita se o saldo não cobre (`WALLET_INSUFFICIENT_FUNDS`) |
| WIN | Crédito | Opcional. Se informada, tem que ser BET | Pode apontar para a BET da mesma rodada |
| LOSS | Nenhum. Sem lançamento | Opcional. Se informada, tem que ser BET | Registra o resultado da BET sem mover saldo |
| REFUND | Crédito do valor da BET | Obrigatória. Só BET | Reverte uma BET PROCESSED, uma única vez |
| ROLLBACK | Inverso da referência | Obrigatória. BET, WIN ou REFUND | Reverter BET credita. Reverter WIN ou REFUND debita |

**Dois ids por transação.** O `externalTransactionId` é o id que o provedor escolhe e envia. O `referenceExternalTransactionId` também é um id do provedor, e aponta para o `externalTransactionId` de outra transação. O `transactionId` é um UUID gerado por nós, que volta na resposta da API. O provedor não conhece esse id, a menos que guarde a resposta. Quando a referência é aplicada, o sistema grava o `transactionId` da BET em `reference_transaction_id`. Por isso a ligação entre WIN e BET passa pelos ids do provedor, e o sistema traduz para o id interno no banco.

**Várias apostas na mesma rodada.** O `roundId` não é único. Uma mesma rodada pode ter várias BETs do mesmo jogo, e cada uma é identificada pelo seu `externalTransactionId`. O `gameId` identifica o tipo de jogo, não uma aposta. Por isso, rodada e jogo não bastam para separar as apostas.

**Quem pode apontar para quem.** WIN e LOSS só apontam para BET, e a spec não diz isso de forma explícita para o LOSS. A regra é uma interpretação nossa. Ela se apoia no fluxo da seção 3 (BET → WIN ou LOSS) e na seção 7, que diz que WIN referencia BET. Por isso um WIN não pode apontar para um LOSS, nem um LOSS para um WIN, e nenhum dos dois pode apontar para outro WIN ou LOSS. A restrição vem de `allowedReferenceKinds` e é recusada com `REFERENCE_INVALID_KIND`. Só ROLLBACK pode apontar para um WIN ou REFUND.

**Validações da referência,** na ordem em que acontecem, sempre sob o lock da wallet:

1. A referência existe para o mesmo provedor? Se não, a transação fica em `PENDING_REFERENCE`.
2. Ela pertence à mesma wallet, jogador, moeda e rodada? Se não, `REFERENCE_MISMATCH`.
3. O tipo da referência é aceito por este tipo de transação? Se não, `REFERENCE_INVALID_KIND`.
4. A referência está PROCESSED? Se não, `REFERENCE_NOT_PROCESSED`.
5. Em REFUND e ROLLBACK, o valor é igual ao da referência? Se não, `REFERENCE_AMOUNT_MISMATCH`.
6. Em REFUND e ROLLBACK, a referência já foi revertida? Se sim, `REFERENCE_ALREADY_REVERSED`.
7. Em WIN e LOSS, a BET já tem outro desfecho? Se sim, `REFERENCE_ALREADY_SETTLED`.

### 6.1 Decisões sobre as regras

A spec deixa algumas coisas em aberto. Estas são as nossas escolhas.

**Uma reversão por transação, no total.** A spec diz que uma referência não pode ser revertida duas vezes "pelo mesmo tipo de operação". Se REFUND e ROLLBACK da mesma BET fossem permitidos, o valor seria creditado duas vezes, e isso quebra a regra de não duplicar créditos. Por isso a restrição vale para o total de reversões, e o índice do banco a aplica.

**WIN sem referência é aceito.** A spec diz que o WIN "pode" referenciar a BET. A referência é opcional.

**LOSS pode referenciar a BET que ele fecha.** Esta foi uma mudança depois da primeira versão. Antes, LOSS não aceitava referência, e isso deixava a perda sem ligação com a aposta. Uma rodada pode ter várias apostas, cada uma com seu próprio desfecho. Por exemplo: o jogador aposta no amarelo e no preto na mesma rodada, e uma aposta ganha enquanto a outra perde. Sem a referência, o LOSS não diz qual aposta perdeu.

- A referência segue a mesma regra do WIN: tem que ser uma BET, do mesmo provedor, carteira, jogador, moeda e rodada, e estar PROCESSED.
- A spec não proíbe a referência em LOSS. A restrição anterior era nossa, e agora ela foi removida.
- O LOSS continua fora do extrato (ledger). A seção 6.3 da spec diz que operações sem efeito no saldo não geram lançamento. A referência só liga a perda à aposta; ela não cria movimento financeiro.
- Nenhuma migration foi necessária. O índice de reversão vale só para REFUND e ROLLBACK, então não há colisão.

**Limitações da decisão acima:**

**Um desfecho por BET.** Uma BET recebe um único resultado, WIN ou LOSS. Se já existe um desfecho apontando para ela, o próximo recebe `REFERENCE_ALREADY_SETTLED` e não move saldo. A regra vale nos dois sentidos: um LOSS depois de um WIN é recusado, e um WIN depois de um LOSS também. A checagem roda sob o lock da wallet, então dois desfechos concorrentes não passam juntos. Um desfecho ainda pendente de referência não conta: só PENDING e PROCESSED bloqueiam.

A regra também cobre dois WINs para a mesma BET. O segundo é recusado, para que um único débito não gere dois prêmios.

**Limitações da decisão acima:**
- O valor do LOSS não é comparado com o da BET. Ele é só informativo.
- O teste de carga foi feito numa única máquina, com uma instância da API. Não há medição com várias instâncias nem com banco em outro host (ver 8.1).
- Não há endpoint para listar as transações de uma rodada. A consulta por rodada é feita direto no banco, filtrando por `round_id`.

**Valor negativo na reversão.** Quando um ROLLBACK de WIN ou de REFUND debitaria mais do que o saldo, o código é `REVERSAL_WOULD_BE_NEGATIVE`. Assim ele se distingue de uma aposta sem saldo (`WALLET_INSUFFICIENT_FUNDS`), que é outra situação operacional.

**Replay de transação pendente.** Quando a mesma requisição chega de novo, a resposta mostra o status atual. Se a referência chegou e a transação foi processada, o replay mostra PROCESSED.

### 6.2 Referências fora de ordem

- Quando a referência ainda não existe, a transação fica em `PENDING_REFERENCE`, o evento `WagerTransactionPendingReference` é gravado e a API responde 202.
- O `PendingReferenceWorker` reprocessa as transações vencidas. Cada uma é reavaliada sob o lock da sua wallet e só é processada se ainda estiver pendente. Vários workers podem rodar juntos.
- **Backoff:** `1s × 2^tentativas`, limitado a 60s.
- **Limite:** depois de 5 tentativas (padrão) ou 24 horas desde a criação, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND`, e o evento `WagerTransactionRejected` é gravado.

### 6.3 Códigos de falha

Os códigos ficam em `src/domain/wagering/failure-code.ts`.

| Código | Quando |
| --- | --- |
| `WALLET_INSUFFICIENT_FUNDS` | Aposta ou débito sem saldo |
| `REVERSAL_WOULD_BE_NEGATIVE` | Reversão que deixaria o saldo negativo |
| `REFERENCE_NOT_FOUND` | A referência não apareceu dentro do limite de tentativas ou do TTL |
| `REFERENCE_MISMATCH` | A referência é de outro provedor, jogador, carteira, moeda ou rodada |
| `REFERENCE_INVALID_KIND` | O tipo da referência não é aceito por este tipo de transação |
| `REFERENCE_NOT_PROCESSED` | A referência existe, mas não está PROCESSED |
| `REFERENCE_AMOUNT_MISMATCH` | O valor de REFUND ou ROLLBACK é diferente do da referência |
| `REFERENCE_ALREADY_REVERSED` | A referência já foi revertida |
| `REFERENCE_ALREADY_SETTLED` | A BET já tem um desfecho (WIN ou LOSS) |
| `INFRASTRUCTURE_FAILURE` | Falha de infraestrutura que persistiu até o limite de tentativas. A transação fica `FAILED` |

**Estado FAILED.** Uma transação vira `FAILED` quando a falha de infraestrutura persiste até o último recebimento permitido pelo consumidor. Ela é gravada sem saldo e sem lançamento, com `failure_code = INFRASTRUCTURE_FAILURE`, e fica como estado final para auditoria. A mensagem vai para a DLQ. Se a mesma transação chegar de novo, a resposta é um replay com `status: FAILED`, e a API responde 500. O provedor não deve reenviar sem investigar. Esse estado vale para falha de infraestrutura, e não para regra de negócio, que continua usando `REJECTED`.

Não há reprocessamento automático de transações `FAILED`. Se a causa for resolvida, a transação só pode ser enviada de novo com outro `externalTransactionId`, por decisão operacional.

### 6.4 Eventos na outbox

Os eventos são gravados na mesma transação do banco que muda o estado.

| Evento | Quando |
| --- | --- |
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive LOSS |
| `WalletBalanceChanged` | Só quando o saldo muda |
| `WagerTransactionRejected` | Transação rejeitada |
| `WagerTransactionPendingReference` | Referência ausente |

### 6.5 Modelo de domínio das transações

As regras de estado ficam em classes, não em SQL espalhado.

- **`WagerTransaction`** (`src/domain/wagering/wager-transaction.ts`) nasce `PENDING` e só muda de estado por `markProcessed`, `reject`, `awaitReference` e `fail`. Uma transição fora da tabela lança `WAGER_INVALID_TRANSITION`, inclusive qualquer mudança depois de um estado final. O `UPDATE` do caso de uso repete a condição `AND status = <estado anterior>`, então o banco recusa a transição concorrente também. As consultas de domínio seguem os nomes da spec: `affectsBalance()` (falso só para LOSS), `matchesPayload(hash)` (o replay usa para separar repetição de conflito) e `ledgerDirectionFor(referencia?)` (ROLLBACK depende do tipo da transação que reverte, por isso recebe a referência). O hash do payload fica no estado da transação.
- **`IntegrationEvent<T>`** (`src/domain/messaging/integration-event.ts`) é a base dos eventos. Cada subclasse define `eventType` e `version`, e `toJSON()` monta o envelope da seção 11 da spec. As subclasses estão em `wager-events.ts` e `wallet-events.ts`. A `causationId` é opcional: eventos de transações recebidas da fila levam o `messageId` da mensagem como causa. Eventos da API não têm o campo, para que o envelope não ganhe campos sem causa.
- **`OutboxMessage` e `InboxMessage`** (`src/domain/messaging/`) guardam o backoff da outbox e o ciclo de vida da inbox. O publicador usa `OutboxMessage`, e o caso de uso usa `InboxMessage`.

## 6.1 Mensageria (SQS)

**Filas**, criadas no boot pelo `ensureQueues`:

| Fila | Papel | Configuração |
| --- | --- | --- |
| `wager-transactions.fifo` | Entrada: transações enviadas pelos provedores | FIFO, redrive para a DLQ depois de `WAGER_MAX_RECEIVE_COUNT` tentativas (padrão 5) |
| `wager-transactions-dlq.fifo` | Dead-letter queue | FIFO |
| `wager-events.fifo` | Saída: eventos da outbox | FIFO. Grupo = agregado. Deduplicação = id do evento |

**Consumidor (`WagerConsumer`):**

- Usa o mesmo caso de uso da entrada HTTP. A `inbox` é gravada na mesma transação da aposta, então uma mensagem entregue de novo cai no replay e não gera efeito duplicado.
- O ack (`DeleteMessage`) só acontece depois do commit. Se o processo morrer entre o commit e o ack, a mensagem volta, e a inbox impede o débito duplicado. Isso é testado com o gancho `beforeAck`.
- Os erros são classificados em três grupos:
  - **Malformada** (JSON inválido, envelope fora do contrato, valor inválido): vai para a DLQ e a original é apagada.
  - **De negócio** (carteira inexistente, conflito de idempotência, moeda divergente): ack, porque a resposta é definitiva.
  - **Transitória** (conexão, serialização, deadlock) ou inesperada: a mensagem não é apagada. A visibilidade muda com backoff exponencial. No último recebimento permitido (`maxReceiveCount`), se a falha persistir, a transação é gravada como `FAILED` com o código `INFRASTRUCTURE_FAILURE`, e a mensagem vai para a DLQ. Se não der para gravar (por exemplo, o banco está fora), a mensagem segue o caminho normal e o SQS a redireciona.
- Cada mensagem do lote é isolada. Uma falha não atrasa as outras.
- `stop()` (SIGTERM) espera o lote em andamento terminar antes de devolver o controle.

**Publicador da outbox (`OutboxPublisher`):**

- Pega um lote com `SELECT ... FOR UPDATE SKIP LOCKED`. Vários publishers rodam ao mesmo tempo sem pegar os mesmos eventos. Testado com dois publishers sobre 60 eventos: todos saem, nenhum sai duplicado.
- Quando a publicação falha, o evento é reagendado com backoff, sem travar os outros.
- A entrega é at-least-once. Se o processo morrer depois de publicar e antes de marcar como publicado, o evento sai de novo. O id do evento é a `MessageDeduplicationId` da FIFO, então o SQS descarta a repetição dentro da janela de 5 minutos.

**Readiness:** `/health/ready` testa o PostgreSQL (`SELECT 1`) e o SQS (`ListQueues`). Responde 503 se algum dos dois falhar.

**Testes:** `test/integration/messaging.test.ts` roda contra o SQS real, no LocalStack, com filas próprias por teste. Cobre processamento com ack, mensagem duplicada, crash entre commit e ack, malformada indo para a DLQ, transitória até a DLQ, erro de negócio sem DLQ, ROLLBACK antes da BET, reinício no meio do lote, outbox publicada, dois publishers concorrentes e backoff de publicação.

**Publicador que morre no meio:** `test/integration/outbox-crash.test.ts` usa um processo filho que envia o primeiro evento ao SQS e morre antes de confirmar a transação. O evento continua pendente. Outro publicador assume, reenvia, e a deduplicação da FIFO impede a cópia: cada evento aparece uma única vez na fila. No Windows, o `SIGKILL` sai como código de saída diferente de zero, e o teste confere isso junto com a ausência de stderr.

## 6.2 Reconciliação

`POST /wallets/:walletId/reconciliation` compara o saldo guardado com o saldo reconstruído pela soma do ledger.

- **Snapshot consistente:** a comparação é uma única instrução SQL. Ela vê cada movimento inteiro, saldo e lançamento juntos, ou não vê nenhum dos dois.
- **Resposta:** `storedBalance`, `calculatedBalance`, `difference` (com sinal), `consistent` e `checkedEntries`. Responde 200 nos dois casos, e `consistent` diz o resultado. Responde 404 se a wallet não existe.
- **Divergência não é corrigida.** Ela é logada como `error` com identificadores e valores, conta na métrica `wallet_reconciliation_divergences_total` e aparece na resposta. Corrigir em silêncio esconderia um problema real.
- **Teste:** `test/integration/reconciliation.test.ts` simula corrupção com um `UPDATE` direto no saldo. O ledger é imutável, mas o saldo não é protegido por trigger. O teste confere a sinalização, a métrica e que o saldo continua divergente depois da chamada.

## 6.3 Métricas

Expostas em `GET /metrics`, em texto no formato Prometheus. Cada processo tem as suas.

| Métrica | Tipo | Rótulos | O que mostra |
| --- | --- | --- | --- |
| `wager_transactions_total` | counter | `kind`, `status` | Transações novas processadas, por resultado |
| `wager_duplicates_detected_total` | counter | `kind` | Repetições detectadas pela idempotência |
| `wager_errors_total` | counter | `code` | Transações que terminaram com erro de aplicação |
| `wager_processing_seconds` | summary | `kind` | Tempo de processamento de uma transação |
| `wallet_lock_wait_seconds` | summary | | Tempo esperando o lock da wallet |
| `wallet_lock_contention_total` | counter | | Esperas de lock acima de 50 ms, ou seja, disputa na mesma wallet |
| `wager_reference_retries_total` | counter | `kind` | Reprocessamentos de transações aguardando referência |
| `wager_consumer_messages_total` | counter | `outcome` | Mensagens da fila: `processed`, `business`, `transient`, `malformed` |
| `wager_consumer_retries_total` | counter | | Mensagens reagendadas por falha transitória |
| `wager_dlq_messages_total` | counter | `reason` | Mensagens que o consumidor mandou para a DLQ (malformadas) |
| `outbox_events_published_total` | counter | | Eventos da outbox publicados |
| `outbox_lag_seconds` | gauge | | Idade do evento pendente mais antigo |
| `wallet_reconciliation_divergences_total` | counter | | Divergências encontradas pela reconciliação |

**Limitações:** as métricas são por processo e não são agregadas entre instâncias. Mensagens que o SQS move para a DLQ pelo redrive não aparecem em `wager_dlq_messages_total`, porque esse contador só conta os envios feitos pelo consumidor. Para ver a DLQ inteira, consulte o SQS (`ApproximateNumberOfMessages`).

**Teste:** `test/integration/metrics.test.ts` confere os valores depois de transações, repetições, rejeições, erro de wallet inexistente e publicação da outbox.

**Logs.** Cada log de processamento traz `correlationId`. Quando a transação existe, ele é o `transactionId`, que é também o id do agregado usado nos eventos. Antes disso, é o `messageId` da fila ou a `Idempotency-Key` da API. Na reconciliação, é o `walletId`. Os logs de resultado saem depois do commit. Os valores financeiros completos não entram nos logs, só os identificadores e o status.

## 7. API HTTP e status

| Endpoint | O que faz |
| --- | --- |
| `POST /wallets` | Cria a wallet com saldo inicial (201). Duplicada: 409 |
| `GET /wallets/:walletId` | Saldo e versão (200, 404) |
| `GET /wallets/:walletId/ledger?cursor&limit` | Lançamentos paginados, do mais recente para o mais antigo. `limit` vai de 1 a 100 |
| `POST /wagering/transactions` | Envia uma transação. Exige o header `Idempotency-Key`. Aceita `referenceExternalTransactionId`, conforme o tipo |
| `GET /wagering/transactions/:transactionId` | Consulta pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` | Liveness, sem autenticação |

**Status HTTP**, iguais em todos os endpoints:

| Status | Quando | Corpo |
| --- | --- | --- |
| 200 | Aplicada (`PROCESSED`), inclusive replay (`idempotentReplay: true`) | Transação e saldo |
| 201 | Wallet criada | Wallet |
| 202 | Aguardando referência (`PENDING_REFERENCE`) | Transação e saldo |
| 400 | Payload inválido, UUID malformado, Money inválido, referência ausente em REFUND ou ROLLBACK, referência presente em BET, cursor ou limit inválidos, header ausente | `error.code` |
| 404 | Wallet ou transação não existe | `error.code` |
| 409 | Conflito de idempotência ou wallet duplicada | `error.code` |
| 422 | Rejeição por regra de negócio (`REJECTED`), jogador ou moeda divergentes, tipo desconhecido | Transação com `failureCode` |
| 503 | Falha transitória de conexão com o banco. O provedor pode reenviar | `error.code` |
| 500 | Erro inesperado, ou transação `FAILED` (replay de falha permanente) | `error.code`, ou transação com `failureCode` |

Na rejeição por regra de negócio, o `failureCode` diz se foi saldo insuficiente, referência inválida ou reversão já feita. Assim o provedor decide se reenvia, corrige o payload ou desiste.

## 8. Testes

- **Unitários** (`test/unit`): `Money`, `Wallet`, `WalletLedgerEntry`, as regras puras por tipo, as classes de transação e de mensageria.
- **Integração** (`test/integration`): contra PostgreSQL real, sem mocks.
  - `schema.test.ts`: constraints, triggers do ledger e reversibilidade das migrations.
  - `submit-bet.test.ts`: BET, idempotência, concorrência e o cenário obrigatório da spec.
  - `wagering-rules.test.ts`: WIN, LOSS, REFUND, ROLLBACK, referências pendentes, worker e corridas de reversão.
  - `http.test.ts`: API HTTP de ponta a ponta.
  - `multi-process.test.ts`: três processos disputando a mesma wallet.
  - `messaging.test.ts` e `metrics.test.ts`: fila, outbox e métricas.
  - `outbox-crash.test.ts`: publicador que morre depois de enviar, em processo real.
- **Banco:** `docker compose up -d` sobe PostgreSQL e LocalStack com o `docker-compose.yml` da raiz. O devcontainer usa o mesmo arquivo. `TEST_DATABASE_URL` aponta para o banco de teste.

### 8.1 Teste de carga (`bun run test:load`)

O script `scripts/load-test.ts` envia apostas concorrentes para a API, mede cada resposta e, no fim, confere o saldo de cada carteira, a reconciliação e o tempo até a outbox esvaziar. Ele reprova quando há erro 5xx, falha de rede, saldo divergente ou reconciliação inconsistente. Latência alta é medida e reportada, mas não reprova.

**Ambiente da medição:** Windows 11, Bun 1.4.4, 12 CPUs lógicos. PostgreSQL 16 e LocalStack rodando no WSL. Uma instância da API (porta 3100) com o código atual, usando o banco de desenvolvimento (`DATABASE_URL`). O gerador de carga roda no mesmo computador.

**Metodologia:** apostas de BET de 0,01 BRL. Cada carteira começa com 1.000,00 BRL. As apostas são distribuídas nas carteiras em revezamento. Cada aposta tem sua própria `Idempotency-Key`. Ao final, o saldo esperado de cada carteira é o inicial menos as apostas aceitas.

**Resultados** (uma execução por cenário):

| Cenário | Apostas | Simultâneas | Carteiras | Vazão | p50 | p95 | p99 | Erros | Lag máx. da outbox | Tempo para esvaziar a outbox |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Distribuído | 2.000 | 50 | 10 | 244,5 req/s | 200 ms | 263 ms | 286 ms | 0 | 5,7 s | 75,9 s |
| Carteira quente | 1.000 | 50 | 1 | 124,7 req/s | 388 ms | 488 ms | 510 ms | 0 | 5,4 s | 35,9 s |

Nos dois cenários, todas as respostas foram `200 PROCESSED`, e nenhuma carteira teve saldo divergente ou reconciliação inconsistente.

Medição anterior, com MikroORM, na mesma máquina, para comparação: distribuído 120,7 req/s, p50 385 ms, p99 890 ms, outbox em 31,5 s; carteira quente 121,8 req/s, p50 391 ms, p99 560 ms, outbox em 14,7 s. Cada ORM foi medido numa execução, em momentos diferentes, então a comparação não é controlada.

**Interpretação:**

- A carteira quente teve a mesma vazão nos dois ORMs, em torno de 122 req/s. Isso sugere que o limite não está no ORM. A hipótese mais provável é a API e o gerador de carga dividirem o mesmo computador. Não medimos isso.
- Com TypeORM, o cenário distribuído fez o dobro da vazão da carteira quente (245 contra 125 req/s). Essa diferença é o efeito esperado do lock por wallet: as 50 requisições disputam a mesma linha quando a carteira é única. Na medição com MikroORM, essa diferença não apareceu, então as duas medições não são comparáveis entre si.
- O cenário distribuído subiu de 121 para 245 req/s em relação à medição com MikroORM. Não dá para atribuir essa diferença ao TypeORM com uma execução por ORM.
- A outbox é o gargalo medido. O publicador envia no máximo 50 eventos por segundo, porque processa um lote de 50 a cada tick de 1 segundo. Com 4.000 eventos, o esvaziamento leva cerca de 76 s. Uma melhoria seria esvaziar o lote na hora, enquanto houver eventos vencidos.
- A latência ficou abaixo de 1 s até o p99, com 50 requisições simultâneas.

**Limitações da medição:** uma execução por cenário; gerador e API no mesmo computador; uma única instância da API; só BET, sem WIN ou REFUND concorrentes (esses casos estão nos testes de integração); a latência é medida no cliente.

**Como reproduzir:** `bun run test:load`, com `LOAD_API_URL`, `LOAD_REQUESTS`, `LOAD_CONCURRENCY`, `LOAD_WALLETS` e `LOAD_DRAIN_MS` para ajustar o cenário.

### 8.2 Stubs nos testes

Três testes usam stubs para forçar falhas que não acontecem sozinhas:

- `test/integration/messaging.test.ts`, "erro transitório reentrega até o limite e depois cai na DLQ": o caso de uso sempre lança erro de conexão.
- `test/integration/messaging.test.ts`, "falha ao publicar é reagendada com backoff": o publicador falha na primeira tentativa.
- `test/integration/failed-transaction.test.ts`: o caso de uso sempre lança erro de conexão, mas o registro de FAILED usa o caso de uso real, com o banco real.

Os recursos reais, PostgreSQL e SQS, continuam em uso em todos esses testes. O stub troca só o comportamento que provoca a falha. O teste da morte do publicador (`outbox-crash.test.ts`) não usa stub: ele mata um processo real.

## 9. Limitações

- Um WIN ou LOSS sem referência não é ligado a nenhuma BET e não passa pela checagem de um desfecho por BET. Isso permite que uma BET receba um LOSS com referência e, depois, um WIN sem referência, e o WIN é creditado.

**Proposta não implementada:** exigir `referenceExternalTransactionId` em WIN e LOSS. Assim todo desfecho ficaria ligado a uma BET, e a regra de um desfecho valeria sem exceção. O custo é que o provedor precisaria enviar o id da aposta em todo WIN e LOSS. Esta proposta ainda não foi aceita nem implementada. Até ser decidida, a regra vale só quando há referência (ver 6.1).

**Proposta alternativa não implementada: tipo DEPOSIT.** Um novo tipo de transação, `DEPOSIT`, teria como única função creditar na carteira. Ele não aceita referência a BET nem a outra transação, e não participa da regra de um desfecho. Com isso, WIN voltaria a significar só prêmio de jogo, e todo crédito sem aposta de origem passaria a ter um tipo próprio, com regras e auditoria próprias. Nessa combinação, a referência em WIN passaria a ser obrigatória, apontando para uma BET. Hoje ela é opcional, e a proposta 1 só exigiria isso em WIN e LOSS. A spec não define depósito, então este tipo seria uma extensão nossa, e precisaria de decisão e de documentação próprias antes de qualquer implementação. Também não há hoje um endpoint nem um fluxo de entrada de dinheiro que o justifique. Esta proposta ainda não foi aceita nem implementada.
- O valor de um LOSS não é comparado com o da BET que ele referencia.
- As métricas são por processo, sem agregação entre instâncias.
- A entrega de eventos é at-least-once. Quem consumir `wager-events.fifo` precisa deduplicar pelo `eventId`.
- Não há ledger de partidas dobradas. Ele é opcional na spec e ficou fora.
- Autenticação: o ponto de extensão existe, mas sem validação real (seção 10).

## 10. Autenticação

### Decisão

A autenticação dos provedores vai ser feita com um Identity Provider externo que fale OIDC. As opções são **Keycloak**, o mais usado no mercado, e **Zitadel**, mais leve e orientado a API. O serviço não guarda usuários nem senhas.

Cada provedor recebe um cliente próprio, com client credentials. Ele obtém um token de acesso do IdP e envia no header `Authorization: Bearer <token>`.

### O que existe hoje

- **`ProviderIdentityPort`** (`src/application/auth/provider-identity.port.ts`): uma interface com um método, `authenticate(authorization)`, que devolve a identidade ou `null`.
- **`NoOpIdentityAdapter`** (`src/infrastructure/auth/no-op-identity.adapter.ts`): implementação sem efeito. Aceita toda requisição como anônima.
- **`AuthGuard`** (`src/api/guards/auth.guard.ts`): chama a porta. Se ela devolve `null`, responde 401. Com o adaptador sem efeito, nenhuma requisição é recusada.
- **Rotas protegidas:** `WalletsController` e `WageringController`. Os health checks e o `/metrics` continuam abertos.
- **Teste:** `test/unit/auth.test.ts` confere que o adaptador sem efeito devolve identidade anônima, que o guard deixa passar com ele, que uma rejeição vira 401 e que a identidade fica disponível na requisição.

Trocar a autenticação não exige mexer nos controllers nem nos casos de uso. Basta trocar o adaptador.

### O que falta para funcionar de verdade

1. **Subir um IdP** no `docker-compose.yml`, com um realm e um cliente por provedor.
2. **Criar um adaptador OIDC** que implemente `ProviderIdentityPort`:
   - ler o Bearer do header;
   - validar a assinatura do JWT com as chaves públicas do IdP (JWKS);
   - conferir emissor (`iss`), audiência (`aud`) e validade (`exp`);
   - devolver o `providerId` a partir de uma claim do token.
   Token inválido ou expirado devolve `null`.
3. **Trocar o provider** em `src/nest-modules/wagering-module/wagering.module.ts`: `{ provide: IDENTITY_PORT, useClass: OidcIdentityAdapter }`.
4. **Amarrar a identidade ao payload.** O `providerId` do token tem que ser igual ao `providerId` da transação. Senão, um provedor poderia lançar em nome de outro. Essa checagem ainda não existe e deve entrar junto com o adaptador.
5. **Testes:** token válido, token expirado, assinatura inválida, emissor errado e provider diferente do payload.

### Limites deste desenho

- A spec aceita que a fila não seja autenticada. Mensagens do SQS são tratadas como canal interno confiável. A identidade do provedor dentro da mensagem continua sujeita às validações de domínio (jogador, carteira, moeda e rodada).
- Não há controle de acesso por papel (RBAC). Qualquer cliente autenticado pode chamar qualquer endpoint protegido.
