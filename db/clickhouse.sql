-- Итоговая таблица событий. ReplacingMergeTree по event_id убирает дубли от at-least-once доставки
-- (при слиянии кусков; в запросах используем FINAL).
CREATE TABLE IF NOT EXISTS deal_events (
  event_id   UInt64,
  event_type LowCardinality(String),
  deal_id    UUID,
  buyer_id   UUID,
  seller_id  UUID,
  amount     UInt64, -- копейки
  status     LowCardinality(String),
  event_time DateTime64(3)
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_type, event_id);

-- Kafka engine: ClickHouse сам читает топик. Битые сообщения не блокируют чтение — они попадают в _error.
CREATE TABLE IF NOT EXISTS deal_events_queue (
  id        String,
  buyer_id  String,
  seller_id String,
  amount    String,
  status    String
) ENGINE = Kafka
SETTINGS kafka_broker_list = '{KAFKA_BROKERS}',
         kafka_topic_list = 'deals.events',
         kafka_group_name = 'clickhouse-analytics',
         kafka_format = 'JSONEachRow',
         kafka_handle_error_mode = 'stream';

-- Материализованное представление переносит каждую прочитанную пачку из очереди в deal_events.
CREATE MATERIALIZED VIEW IF NOT EXISTS deal_events_mv TO deal_events AS
SELECT
  toUInt64OrZero(_headers.value[indexOf(_headers.name, 'event-id')]) AS event_id,
  _headers.value[indexOf(_headers.name, 'event-type')]               AS event_type,
  toUUIDOrZero(id)                                                   AS deal_id,
  toUUIDOrZero(buyer_id)                                             AS buyer_id,
  toUUIDOrZero(seller_id)                                            AS seller_id,
  toUInt64OrZero(amount)                                             AS amount,
  status,
  ifNull(_timestamp_ms, now64(3))                                    AS event_time
FROM deal_events_queue
WHERE length(_error) = 0 AND event_id > 0 AND deal_id != toUUID('00000000-0000-0000-0000-000000000000');
