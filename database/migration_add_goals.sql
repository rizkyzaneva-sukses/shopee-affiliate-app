-- Migration: Add goals table for target tracking
-- Safe to run multiple times (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS goals (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  target_gmv        NUMERIC(18,2) DEFAULT 0,
  target_orders     INTEGER DEFAULT 0,
  target_commission NUMERIC(18,2) DEFAULT 0,
  period            VARCHAR(20) DEFAULT 'Month', -- Month | Week | Custom
  active            BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
