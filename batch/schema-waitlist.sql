-- Add waitlist support to territory_claims
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS waitlist_position INTEGER;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS waitlist_card_on_file BOOLEAN DEFAULT FALSE;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS waitlist_stripe_customer_id TEXT;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS agent_name TEXT;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS agent_email TEXT;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS agent_phone TEXT;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS agent_brokerage TEXT;

-- Allow multiple rows per zip (one active + multiple waitlist)
-- Drop the old PK if it's zip_code only
ALTER TABLE territory_claims DROP CONSTRAINT IF EXISTS territory_claims_pkey;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE territory_claims ADD CONSTRAINT territory_claims_pkey PRIMARY KEY (id);

-- Unique constraint: only one active claim per ZIP
CREATE UNIQUE INDEX IF NOT EXISTS idx_territory_active_zip 
  ON territory_claims(zip_code) WHERE status = 'active';

-- Index for waitlist queries
CREATE INDEX IF NOT EXISTS idx_territory_waitlist 
  ON territory_claims(zip_code, waitlist_position) WHERE status = 'waitlist';
