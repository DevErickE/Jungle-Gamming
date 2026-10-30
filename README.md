# projeto_jungle_gamming

Serviço que recebe apostas de provedores de jogos, grava o saldo do jogador e um ledger com cada movimento. Usa Bun, NestJS, TypeORM, PostgreSQL e SQS (simulado com LocalStack).

## O que você precisa

- Bun 1.x
- Docker com Docker Compose. No Windows, o Docker do WSL funciona.

## Subir o projeto

```bash
bun install
cp .env.example .env
docker compose up -d
bun run db:migrate
bun run start:dev
```

Para conferir se a API respondeu:

```bash
curl http://localhost:3000/health/live
```

Se você já tinha o banco de uma versão anterior, com MikroORM, recrie o schema antes de migrar. Isso apaga todos os dados do banco apontado por `DATABASE_URL`:

```bash
bun run db:reset
```

O script `scripts/db-reset.ts` apaga o schema, recria e aplica as migrations. Ele só roda com `--yes`, que já vem no comando. Para usar em outro banco, defina `DATABASE_URL` antes, ou ajuste o bloco de configuração no topo do arquivo.

## Estrutura de pastas

```
src/
  api/                  controllers, filtros de erro, guards e validação de entrada
  application/          casos de uso, portas, erros e DTOs de contrato (Swagger)
  config/               configuração de CORS, Swagger e afins
  domain/               Money, Wallet, ledger e regras de transação, sem dependências de framework
  infrastructure/       persistência (TypeORM), mensageria (SQS), métricas e logs
  nest-modules/         módulos do NestJS que ligam tudo
test/
  unit/                 testes sem banco
  integration/          testes com PostgreSQL e LocalStack reais
  helpers/, fixtures/   apoio aos testes
scripts/                migrate.ts e demo.ts
```

## Comandos

| Comando | O que faz |
| --- | --- |
| `bun run start:dev` | Sobe a API com reload a cada alteração |
| `bun run typecheck` | Checa os tipos em modo estrito |
| `bun test` | Roda todos os testes. Exige o banco e o LocalStack no ar |
| `bun test test/unit` | Roda só os testes unitários, sem banco |
| `bun run demo` | Roda o fluxo completo contra a API e explica cada passo |
| `docker compose up -d` | Sobe PostgreSQL e LocalStack |
| `docker compose down` | Para PostgreSQL e LocalStack |
| `bun run db:migrate` | Aplica as migrations pendentes |
| `bun run db:migrate:down` | Desfaz a última migration |
| `bun run db:reset` | Apaga o schema de `DATABASE_URL`, recria e aplica as migrations. Apaga os dados |

Os testes de integração usam `TEST_DATABASE_URL`, que por padrão aponta para `postgres://wallet:wallet@127.0.0.1:5432/wallet_test`. O banco de teste é recriado a cada execução, então ele nunca mistura dados com o banco de desenvolvimento.

## Ver os dados no banco

Os dados ficam no PostgreSQL que roda no container. Para abrir um terminal dentro dele:

```bash
docker exec -it projeto_jungle_gamming-postgres-1 psql -U wallet -d wallet
```

Você não precisa da API rodando para isso. Só o container do banco precisa estar no ar. Se o comando falhar, confira com `docker ps`.

Dentro do `psql`, estes comandos ajudam a navegar:

```sql
\dt                                    -- lista as tabelas
\d wallets                             -- mostra as colunas de uma tabela
SELECT * FROM wallets;                 -- carteiras e saldos
SELECT * FROM wallet_ledger_entries
  ORDER BY wallet_version;             -- lançamentos, do primeiro ao último
SELECT * FROM wager_transactions;      -- transações de aposta e seus status
```

Para sair, digite `\q`.

Não grave dados com `INSERT` ou `UPDATE` direto no banco. Isso pula as regras do domínio: o saldo não é recalculado, o lançamento no ledger não é criado e a idempotência não é checada. Para criar carteiras e apostas, use a API ou o `bun run demo`. A tabela `wallet_ledger_entries` tem um trigger que bloqueia `UPDATE` e `DELETE`, de propósito.

## Devcontainer

Com a extensão **Dev Containers** do VS Code, abra a pasta do projeto e escolha **Reopen in Container**. A configuração está em `.devcontainer/` e sobe três serviços: a aplicação (`oven/bun`), o PostgreSQL e o LocalStack. Na criação do container, o `bun install` e as migrations rodam sozinhos.

O devcontainer reaproveita o `docker-compose.yml` da raiz e só acrescenta o serviço da aplicação, pelo arquivo `.devcontainer/docker-compose.yml`. Por isso o PostgreSQL e o LocalStack são os mesmos nos dois modos. Não rode o `docker compose` da raiz e o devcontainer ao mesmo tempo, porque as portas 5432 e 4566 entram em conflito.

## Variáveis de ambiente

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://wallet:wallet@127.0.0.1:5432/wallet` | Conexão com o PostgreSQL |
| `AWS_ENDPOINT_URL` | (AWS real) | Endereço do SQS. Use `http://127.0.0.1:4566` com o LocalStack |
| `AWS_REGION` | `us-east-1` | Região |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | Credenciais. O LocalStack aceita qualquer valor |
| `MESSAGING_WORKERS` | ligado | `disabled` desliga o consumidor e o publicador da outbox |
| `PENDING_REFERENCE_WORKER` | ligado | `disabled` desliga o reprocessamento de referências pendentes |
| `WAGER_QUEUE_NAME` | `wager-transactions.fifo` | Fila de entrada |
| `WAGER_DLQ_NAME` | `wager-transactions-dlq.fifo` | Fila de mensagens que não podem ser processadas |
| `WAGER_EVENTS_QUEUE_NAME` | `wager-events.fifo` | Fila dos eventos publicados pela outbox |
| `WAGER_MAX_RECEIVE_COUNT` | `5` | Tentativas antes de mandar a mensagem para a DLQ |
| `WAGER_VISIBILITY_TIMEOUT` | `30` | Tempo, em segundos, em que a mensagem fica invisível para outros consumidores |

As filas são criadas automaticamente quando a aplicação sobe. Os testes de mensageria (`test/integration/messaging.test.ts`) usam `AWS_ENDPOINT_URL=http://127.0.0.1:4566` por padrão.

## Endpoints

| Método | Caminho | O que faz |
| --- | --- | --- |
| POST | `/wallets` | Cria a carteira com saldo inicial |
| GET | `/wallets/:walletId` | Mostra saldo e versão |
| GET | `/wallets/:walletId/ledger?cursor&limit` | Extrato paginado |
| POST | `/wagering/transactions` | Envia BET, WIN, LOSS, REFUND ou ROLLBACK. Exige o header `Idempotency-Key` |
| GET | `/wagering/transactions/:transactionId` | Consulta por id interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo e ledger. Divergência é sinalizada, não corrigida |
| GET | `/health/live` | Confirma que o processo está vivo |
| GET | `/health/ready` | Confirma que o PostgreSQL e o SQS respondem |
| GET | `/metrics` | Contadores do processo, no formato Prometheus |

A documentação interativa fica em `http://localhost:3000/docs`. Ela permite preencher os campos e enviar cada requisição pelo navegador, inclusive com o header `Idempotency-Key`. O contrato OpenAPI está em `http://localhost:3000/openapi-json`. A documentação fica desligada quando `NODE_ENV=production`.

Os status HTTP e os códigos de falha estão explicados no [ARCHITECTURE.md](ARCHITECTURE.md).

## Autenticação

Ainda não há validação real. As rotas de negócio passam por um `AuthGuard`, que usa a porta `ProviderIdentityPort` com um adaptador sem efeito. A troca pelo provedor de identidade (Keycloak ou Zitadel) está descrita no [ARCHITECTURE.md](ARCHITECTURE.md), seção 10.

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md): decisões, trade-offs, limitações e o mapeamento de status HTTP.
