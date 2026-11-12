CREATE TABLE IF NOT EXISTS accounts (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0), -- в копейках
  held    bigint NOT NULL DEFAULT 0 CHECK (held >= 0)     -- заморожено под сделки
);

CREATE TABLE IF NOT EXISTS deals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id   uuid NOT NULL REFERENCES accounts(id),
  seller_id  uuid NOT NULL REFERENCES accounts(id),
  amount     bigint NOT NULL CHECK (amount > 0),
  status     text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> seller_id)
);

-- Одна оплата на сделку; ключ идемпотентности делает повтор запроса безопасным.
CREATE TABLE IF NOT EXISTS payments (
  idempotency_key text PRIMARY KEY,
  deal_id         uuid NOT NULL UNIQUE REFERENCES deals(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox: событие пишется в той же транзакции, что и изменение данных.
CREATE TABLE IF NOT EXISTS outbox (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- Уведомления продавцу; event_id делает обработку события идемпотентной.
CREATE TABLE IF NOT EXISTS notifications (
  event_id   bigint PRIMARY KEY,
  deal_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
