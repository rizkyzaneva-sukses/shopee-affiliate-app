-- =============================================
-- Shopee Affiliate Manager - PostgreSQL Schema
-- =============================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Partner / App settings (single row usually)
CREATE TABLE IF NOT EXISTS settings (
  id              SERIAL PRIMARY KEY,
  partner_id      BIGINT NOT NULL,
  partner_key     TEXT NOT NULL,
  region          VARCHAR(10) DEFAULT 'ID',
  base_url        TEXT DEFAULT 'https://partner.shopeemobile.com',
  redirect_uri    TEXT,
  mode            VARCHAR(10) DEFAULT 'mock', -- mock | live
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Shops that have authorized the app
CREATE TABLE IF NOT EXISTS shops (
  id              SERIAL PRIMARY KEY,
  shop_id         BIGINT NOT NULL UNIQUE,
  shop_name       VARCHAR(255),
  region          VARCHAR(10),
  status          VARCHAR(20) DEFAULT 'active', -- active | inactive | expired
  access_token    TEXT,
  refresh_token   TEXT,
  token_expire_at TIMESTAMPTZ,
  auth_time       TIMESTAMPTZ,
  last_sync_at    TIMESTAMPTZ,
  raw_info        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shops_shop_id ON shops(shop_id);
CREATE INDEX IF NOT EXISTS idx_shops_status ON shops(status);

-- Affiliates (cached from AMS API)
CREATE TABLE IF NOT EXISTS affiliates (
  id              SERIAL PRIMARY KEY,
  affiliate_id    BIGINT NOT NULL,
  shop_id         BIGINT NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
  name            VARCHAR(255),
  username        VARCHAR(255),
  channel         VARCHAR(50),
  followers       VARCHAR(50),
  status          VARCHAR(20) DEFAULT 'active', -- active | warning | inactive
  portrait_url    TEXT,
  social_info     JSONB DEFAULT '{}',
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(affiliate_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_affiliates_shop ON affiliates(shop_id);
CREATE INDEX IF NOT EXISTS idx_affiliates_status ON affiliates(status);

-- Performance snapshots (per period)
CREATE TABLE IF NOT EXISTS affiliate_performance (
  id              SERIAL PRIMARY KEY,
  affiliate_id    BIGINT NOT NULL,
  shop_id         BIGINT NOT NULL,
  period_type     VARCHAR(20) NOT NULL, -- Day | Week | Month | Last7d | Last30d
  start_date      DATE,
  end_date        DATE,
  channel         VARCHAR(50) DEFAULT 'AllChannel',
  gmv             NUMERIC(18,2) DEFAULT 0,
  orders          INTEGER DEFAULT 0,
  clicks          INTEGER DEFAULT 0,
  items_sold      INTEGER DEFAULT 0,
  est_commission  NUMERIC(18,2) DEFAULT 0,
  roi             NUMERIC(10,2) DEFAULT 0,
  total_buyers    INTEGER DEFAULT 0,
  new_buyers      INTEGER DEFAULT 0,
  raw_data        JSONB DEFAULT '{}',
  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(affiliate_id, shop_id, period_type, start_date, end_date, channel)
);

CREATE INDEX IF NOT EXISTS idx_perf_shop_period ON affiliate_performance(shop_id, period_type);
CREATE INDEX IF NOT EXISTS idx_perf_affiliate ON affiliate_performance(affiliate_id);

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id              SERIAL PRIMARY KEY,
  campaign_id     BIGINT,
  shop_id         BIGINT NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
  name            VARCHAR(255),
  type            VARCHAR(20), -- Open | Targeted
  status          VARCHAR(30), -- Upcoming | Ongoing | Terminating
  commission_info TEXT,
  products_count  INTEGER DEFAULT 0,
  affiliates_count INTEGER DEFAULT 0,
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  raw_data        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_shop ON campaigns(shop_id);

-- Sync logs (optional, useful for debugging)
CREATE TABLE IF NOT EXISTS sync_logs (
  id              SERIAL PRIMARY KEY,
  shop_id         BIGINT,
  action          VARCHAR(100),
  status          VARCHAR(20), -- success | error
  message         TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default settings (edit after deploy).
-- Guarded by NOT EXISTS rather than ON CONFLICT: `settings` has no unique
-- constraint besides its serial PK, so ON CONFLICT would never fire and a
-- duplicate row would be added every time this schema is re-applied.
INSERT INTO settings (partner_id, partner_key, region, mode)
SELECT 0, 'CHANGE_ME', 'ID', 'mock'
WHERE NOT EXISTS (SELECT 1 FROM settings);
