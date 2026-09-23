-- Migration: one row per alert kind instead of a new row on every check.
-- /alerts/check upserts by alert_key and deactivates alerts that no longer apply.
-- Safe to run multiple times.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS alert_key VARCHAR(100);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE alerts SET alert_key = title WHERE alert_key IS NULL;

-- Collapse the duplicates piled up by earlier versions, keeping the newest.
DELETE FROM alerts a USING alerts b
WHERE a.alert_key = b.alert_key AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_key ON alerts(alert_key);
