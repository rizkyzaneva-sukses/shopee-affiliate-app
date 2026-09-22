-- Migration: per-day shop totals from v2.ams.get_shop_performance (period_type=Day).
-- Source for the daily trend chart and period comparison.
-- Safe to run multiple times (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS shop_daily_performance (
  shop_id         BIGINT NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  channel         VARCHAR(50) NOT NULL DEFAULT 'AllChannel',
  sales           NUMERIC(18,2) DEFAULT 0,
  orders          INTEGER DEFAULT 0,
  clicks          INTEGER DEFAULT 0,
  est_commission  NUMERIC(18,2) DEFAULT 0,
  items_sold      INTEGER DEFAULT 0,
  total_buyers    INTEGER DEFAULT 0,
  new_buyers      INTEGER DEFAULT 0,
  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (shop_id, date, channel)
);

CREATE INDEX IF NOT EXISTS idx_shop_daily_date ON shop_daily_performance(date);

-- items_sold was in schema.sql but never written; make sure older databases have it.
ALTER TABLE affiliate_performance ADD COLUMN IF NOT EXISTS items_sold INTEGER DEFAULT 0;
