-- 1. Пользователи
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Ресурсы
CREATE TABLE resources (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  location TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Бронирования
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  resource_id INT NOT NULL REFERENCES resources(id),
  owner_id INT NOT NULL REFERENCES users(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 5 AND 300),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by INT REFERENCES users(id),
  cancel_reason TEXT,
  CONSTRAINT chk_booking_time CHECK (ends_at > starts_at)
);

-- 4. Ключи идемпотентности
CREATE TABLE idempotency_keys (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  booking_id INT REFERENCES bookings(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_idempotency_user_key UNIQUE (user_id, key)
);

-- 5. Аудит (для будущего расширения)
CREATE TABLE audit_events (
  id SERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id INT,
  result TEXT NOT NULL,
  trace_id TEXT
);

-- Индексы
CREATE INDEX idx_bookings_owner ON bookings (owner_id, starts_at);
CREATE INDEX idx_bookings_resource_active ON bookings (resource_id, starts_at, ends_at) WHERE status = 'active';

-- Защита от пересечений (Этап 4)
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bookings
ADD CONSTRAINT ex_bookings_no_overlap
EXCLUDE USING gist (
  resource_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
)
WHERE (status = 'active');