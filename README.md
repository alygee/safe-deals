# safe-deals

Сервис безопасных сделок для маркетплейса цифровых товаров: покупатель оплачивает,
деньги замораживаются, после подтверждения получения уходят продавцу.

## Запуск

```bash
docker compose up --build          # API на http://localhost:8080, статистика haproxy на :8404/stats
docker compose up -d postgres clickhouse redis && npm test   # интеграционные тесты
```

## API

| Метод | Путь | Описание |
|---|---|---|
| POST | `/accounts` `{balance}` | создать счёт (сумма в копейках) |
| GET | `/accounts/:id` | баланс и замороженные средства |
| POST | `/deals` `{buyerId, sellerId, amount}` | создать сделку |
| GET | `/deals/:id` | сделка |
| POST | `/deals/:id/pay` + заголовок `Idempotency-Key` | оплата: заморозка средств покупателя |
| POST | `/deals/:id/confirm` | подтверждение: перевод продавцу |

## Ключевые решения

- **Деньги** хранятся в `bigint` (копейки), отдаются строкой: без ошибок округления.
- **Идемпотентность оплаты**: таблица `payments` с уникальными `idempotency_key` и `deal_id`.
  Повтор с тем же ключом возвращает тот же результат, вторая оплата другим ключом получает 409.
- **Конкурентность**: `SELECT ... FOR UPDATE` на сделку и условное списание
  `UPDATE ... WHERE balance >= amount` плюс `CHECK (balance >= 0)` как последняя защита.
- **Transactional outbox**: события `DealCreated`/`DealPaid`/`DealCompleted` пишутся в `outbox`
  в той же транзакции, что и изменение данных.

- **Relay** (`dist/relay.js`) забирает неопубликованные события пачками (`FOR UPDATE SKIP LOCKED`)
  и шлёт в топик `deals.events` идемпотентным продюсером. Ключ сообщения — id сделки,
  поэтому события одной сделки идут по порядку в одной партиции. Доставка at-least-once.
- **Консьюмер уведомлений** (`dist/notifications.js`, группа `notifications`) сохраняет уведомления
  продавцу. Дубли отсекаются по `event_id`. При ошибке — 3 попытки с экспоненциальной задержкой,
  затем сообщение уходит в `deals.events.dlq` с заголовками `error` и `attempts`.

- **Аналитика**: ClickHouse сам читает `deals.events` через Kafka engine (`deal_events_queue`),
  материализованное представление переносит события в `deal_events` (ReplacingMergeTree по `event_id`,
  дубли от at-least-once убираются, в запросах — `FINAL`). Битые сообщения не блокируют чтение:
  `kafka_handle_error_mode = 'stream'` и фильтр по `_error`. Сервис `analytics` (`:3001`) отдаёт агрегаты.

- **Redis** — вспомогательный слой, источник истины для денег остаётся в PostgreSQL:
  - *rate limiting* API сделок: счётчик по IP с фиксированным окном (`INCR` + `EXPIRE` в `MULTI`),
    общий для всех инстансов; `RATE_LIMIT` (по умолчанию 100) за `RATE_LIMIT_WINDOW_SEC` (60).
    Ответ 429 с `Retry-After`, заголовки `X-RateLimit-*`;
  - *кэш аналитики* (cache-aside, TTL `ANALYTICS_CACHE_TTL_SEC` = 30 с): запросы с `FINAL` дорогие;
  - *fail-open*: если Redis недоступен, каждая команда падает за `REDIS_COMMAND_TIMEOUT_MS` (300 мс),
    лимитер пропускает запрос, кэш считает напрямую — API продолжает работать.

```
API ──tx──► deals + outbox ──► relay ──► Kafka deals.events ─┬─► notifications ──► notifications (PG)
                                                             │        └─ 3 попытки ─► deals.events.dlq
                                                             └─► ClickHouse (Kafka engine → MV → deal_events) ◄── analytics API
```

| Метод | Путь | Описание |
|---|---|---|
| GET | `/analytics/gmv?from&to` | число и сумма завершённых сделок за период `[from, to)` |
| GET | `/analytics/top-sellers?from&to&limit` | продавцы по GMV, `limit` 1..100 |

- **Входной трафик**: `nginx (:8080) → haproxy → реплики deals`, `/analytics/` — сразу в сервис аналитики.
  `deals` stateless и масштабируется: `docker compose up -d --scale deals=4` — haproxy (`server-template` + DNS Docker)
  и Prometheus (`dns_sd_configs`) находят реплики сами.
  - *nginx*: единая точка входа, грубый лимит от флуда (50 r/s с IP, `limit_req`), gzip, keepalive к апстримам,
    `X-Request-Id` в ответе и логах. `X-Forwarded-For` перезаписывается — клиент не подделает свой IP.
  - *haproxy*: L7-балансировка `leastconn`, health check `GET /health` (проверяет БД) каждые 2 с,
    инстанс выводится после 2 неудач. Повтор только при ошибке соединения — оплата не уйдёт дважды.
    Заголовок `X-Served-By` показывает инстанс, статистика — http://localhost:8404/stats.
  - Приложение доверяет двум прокси (`TRUST_PROXY_HOPS=2`) и берёт IP клиента из `X-Forwarded-For` —
    rate limit считается по реальному клиенту, а не по адресу haproxy.

- **Наблюдаемость**: Grafana http://localhost:3000 (дашборд открывается сразу), Prometheus http://localhost:9090.
  - API: RPS и p95 по маршрутам, оплаты по результату, event loop lag, пул соединений PostgreSQL (`pg_pool_waiting`),
    backlog outbox — `/metrics` каждой реплики;
  - haproxy — встроенный экспортёр (сессии, статус реплик); Kafka — kafka-exporter (consumer lag).
- **Нагрузочный тест**: k6, полный цикл сделки. Результаты и разбор узких мест — [loadtest/REPORT.md](loadtest/REPORT.md):
  пул соединений → CPU Node → CPU машины; 1 600 → 2 457 запросов/с без ошибок.
  ```bash
  RATE_LIMIT=10000000 docker compose up -d --scale deals=4
  docker compose run --rm -e RATE=600 -e DURATION=30s k6
  ```

Тесты проверяют полный цикл, повтор оплаты, 20 параллельных оплат одной сделки
и параллельные оплаты разных сделок при ограниченном балансе, публикацию outbox
(в том числе при недоступной Kafka), повторы и DLQ, идемпотентность консьюмера.

Проверить DLQ вручную:
```bash
echo 'bad' | docker compose exec -T kafka /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9094 --topic deals.events
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9094 \
  --topic deals.events.dlq --from-beginning --property print.headers=true
```

## План

- [x] Сервис сделок: PostgreSQL, транзакции, идемпотентность, outbox
- [x] Публикация outbox в Kafka, консьюмер с retry и DLQ
- [x] Сервис аналитики: Kafka → ClickHouse, эндпоинт с GMV
- [x] Redis: кэш и rate limiting
- [x] nginx + haproxy перед репликами `deals`
- [x] Prometheus + Grafana, нагрузочный тест k6 и отчёт
- [x] [Дизайн-документ](docs/design.md)
