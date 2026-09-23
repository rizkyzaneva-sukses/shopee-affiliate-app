-- Migration: drop superseded affiliate_performance snapshots.
-- Every read uses only each shop's latest date range per period + channel;
-- older ranges were never read but kept growing with every resync.
-- New syncs prune their own old ranges, so after the first run this is a no-op.
-- Safe to run multiple times.

DELETE FROM affiliate_performance ap
USING (
  SELECT DISTINCT ON (shop_id, period_type, channel)
         shop_id, period_type, channel, start_date, end_date
  FROM affiliate_performance
  ORDER BY shop_id, period_type, channel, synced_at DESC
) lr
WHERE ap.shop_id = lr.shop_id
  AND ap.period_type = lr.period_type
  AND ap.channel = lr.channel
  AND (ap.start_date IS DISTINCT FROM lr.start_date OR ap.end_date IS DISTINCT FROM lr.end_date);

CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(created_at);
