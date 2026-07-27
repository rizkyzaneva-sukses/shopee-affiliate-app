-- Migration: Add alerts table for anomaly detection
-- Safe to run multiple times (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS alerts (
  id                SERIAL PRIMARY KEY,
  type              VARCHAR(20) DEFAULT 'info', -- info | warning | critical
  title             VARCHAR(255) NOT NULL,
  message           TEXT,
  active            BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
