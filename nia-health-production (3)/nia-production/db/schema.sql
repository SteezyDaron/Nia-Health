-- niA Health — PostgreSQL Schema
-- Run: psql -U postgres -d nia_health -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  age             INTEGER,
  goals           TEXT[]        DEFAULT '{}',
  symptoms        TEXT[]        DEFAULT '{}',
  cycle_length    INTEGER       DEFAULT 28,
  period_length   INTEGER       DEFAULT 5,
  last_period_date DATE,
  plan            VARCHAR(50)   DEFAULT 'free',
  is_admin        BOOLEAN       DEFAULT false,
  is_active       BOOLEAN       DEFAULT true,
  avatar_url      TEXT,
  country         VARCHAR(100),
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ─── CYCLE LOGS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cycle_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date  DATE NOT NULL,
  end_date    DATE,
  cycle_day   INTEGER,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DAILY LOGS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_type        VARCHAR(100) NOT NULL,
  value           TEXT,
  numeric_value   DECIMAL(8,2),
  notes           TEXT,
  logged_at       TIMESTAMPTZ DEFAULT NOW()
);
-- log_type examples: 'mood', 'water', 'sleep_hours', 'weight', 'symptom',
--                    'exercise', 'supplement', 'period', 'stress_level'

-- ─── WELLNESS SCORES ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wellness_scores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  scored_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  breakdown   JSONB,
  UNIQUE (user_id, scored_on)
);

-- ─── COMMUNITY POSTS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  tag             VARCHAR(100),
  is_anonymous    BOOLEAN DEFAULT false,
  status          VARCHAR(50) DEFAULT 'pending',
  likes_count     INTEGER DEFAULT 0,
  comments_count  INTEGER DEFAULT 0,
  reports_count   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── POST LIKES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_likes (
  user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  post_id   UUID REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

-- ─── POST REPORTS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_reports (
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  post_id     UUID REFERENCES posts(id) ON DELETE CASCADE,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

-- ─── COMMENTS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  is_anonymous  BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AI CHAT SESSIONS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(255),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        VARCHAR(20) NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  body        TEXT NOT NULL,
  type        VARCHAR(100),
  is_read     BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── BROADCASTS (admin → users) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcasts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id          UUID REFERENCES users(id),
  title             VARCHAR(255) NOT NULL,
  body              TEXT NOT NULL,
  target_audience   VARCHAR(100) DEFAULT 'all',
  recipient_count   INTEGER DEFAULT 0,
  open_count        INTEGER DEFAULT 0,
  sent_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ─── SUPPLEMENT LOGS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplement_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplement_name VARCHAR(255) NOT NULL,
  dose            VARCHAR(100),
  taken_at        TIMESTAMPTZ DEFAULT NOW(),
  logged_on       DATE DEFAULT CURRENT_DATE
);

-- ─── INDEXES ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date   ON daily_logs(user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_logs_type        ON daily_logs(user_id, log_type);
CREATE INDEX IF NOT EXISTS idx_cycle_logs_user        ON cycle_logs(user_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_posts_status           ON posts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user             ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session  ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user     ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wellness_user_date     ON wellness_scores(user_id, scored_on DESC);

-- ─── UPDATED_AT TRIGGER ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at   BEFORE UPDATE ON users   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_posts_updated_at   BEFORE UPDATE ON posts   FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── PAYMENT SETTINGS (Paystack) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_settings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key  VARCHAR(255) UNIQUE NOT NULL,
  setting_val  TEXT DEFAULT '',
  is_sensitive BOOLEAN DEFAULT false,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO payment_settings (setting_key, setting_val, is_sensitive) VALUES
  ('paystack_secret_key',  '', true),
  ('paystack_public_key',  '', false),
  ('currency',             'KES', false),
  ('wellness_price_kes',   '500', false),
  ('premium_price_kes',    '1200', false),
  ('wellness_price_usd',   '5', false),
  ('premium_price_usd',    '12', false),
  ('business_name',        'niA Health', false),
  ('support_email',        'support@niahealth.com', false)
ON CONFLICT (setting_key) DO NOTHING;

-- ─── PAYMENTS TABLE ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      DECIMAL(10,2) NOT NULL,
  currency    VARCHAR(10) DEFAULT 'KES',
  plan        VARCHAR(50) NOT NULL,
  method      VARCHAR(50) DEFAULT 'paystack',
  status      VARCHAR(50) DEFAULT 'pending',
  reference   VARCHAR(255) UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_user   ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_ref    ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
