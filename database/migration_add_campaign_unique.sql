-- Migration: Add UNIQUE constraint on campaigns(campaign_id, shop_id)
-- Required for ON CONFLICT upserts in the campaign sync endpoints.
-- Safe to run multiple times (IF NOT EXISTS).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaigns_campaign_id_shop_id_key'
  ) THEN
    ALTER TABLE campaigns ADD CONSTRAINT campaigns_campaign_id_shop_id_key UNIQUE (campaign_id, shop_id);
  END IF;
END
$$;
