-- ============================================================
-- SellerSignal — Combined Supabase Migration
-- Run this entire script in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. TERRITORY CLAIMS — waitlist support
-- ============================================================

-- Add waitlist columns
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS waitlist_position INTEGER;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS waitlist_card_on_file BOOLEAN DEFAULT FALSE;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS waitlist_stripe_customer_id TEXT;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS agent_name TEXT;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS agent_email TEXT;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS agent_phone TEXT;
ALTER TABLE territory_claims ADD COLUMN IF NOT EXISTS agent_brokerage TEXT;

-- Allow multiple rows per zip (one active + multiple waitlist)
-- Need to restructure PK if it's currently zip_code only
DO $$
BEGIN
  -- Add id column if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'territory_claims' AND column_name = 'id') THEN
    ALTER TABLE territory_claims ADD COLUMN id UUID DEFAULT gen_random_uuid();
  END IF;
  
  -- Drop old PK and recreate with id
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'territory_claims_pkey' AND table_name = 'territory_claims') THEN
    ALTER TABLE territory_claims DROP CONSTRAINT territory_claims_pkey;
  END IF;
  
  ALTER TABLE territory_claims ADD CONSTRAINT territory_claims_pkey PRIMARY KEY (id);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'territory_claims PK migration: %', SQLERRM;
END $$;

-- Unique constraint: only one active claim per ZIP (exclusivity!)
CREATE UNIQUE INDEX IF NOT EXISTS idx_territory_active_zip 
  ON territory_claims(zip_code) WHERE status = 'active';

-- Index for waitlist queries
CREATE INDEX IF NOT EXISTS idx_territory_waitlist 
  ON territory_claims(zip_code, waitlist_position) WHERE status = 'waitlist';

-- ============================================================
-- 2. DIRECT MAIL — credits, enrollments, letters, sends
-- ============================================================

-- Mail credits per agent
CREATE TABLE IF NOT EXISTS mail_credits (
  user_id TEXT PRIMARY KEY,
  credits_remaining INTEGER DEFAULT 0,
  credits_purchased INTEGER DEFAULT 0,
  credits_used INTEGER DEFAULT 0,
  last_purchase_at TIMESTAMP WITH TIME ZONE,
  stripe_customer_id TEXT
);

-- Enrolled sellers — tracks each seller's position in their mail sequence
CREATE TABLE IF NOT EXISTS mail_enrollments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  
  owner_name TEXT,
  property_address TEXT,
  mailing_address TEXT,
  mailing_city TEXT,
  mailing_state TEXT,
  mailing_zip TEXT,
  cohort TEXT,
  
  current_position INTEGER DEFAULT 0,
  total_letters INTEGER DEFAULT 6,
  status TEXT DEFAULT 'active',
  
  enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_sent_at TIMESTAMP WITH TIME ZONE,
  next_send_at TIMESTAMP WITH TIME ZONE,
  
  UNIQUE(parcel_id, agent_id)
);

-- Pre-generated letters — all 6 stored at enrollment time
CREATE TABLE IF NOT EXISTS mail_letters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID REFERENCES mail_enrollments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  
  subject TEXT,
  body_html TEXT NOT NULL,
  body_text TEXT,
  
  dynamic_comp_address TEXT,
  dynamic_comp_price TEXT,
  
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(enrollment_id, position)
);

-- Send log — tracks each physical mailing
CREATE TABLE IF NOT EXISTS mail_sends (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID REFERENCES mail_enrollments(id) ON DELETE CASCADE,
  letter_id UUID REFERENCES mail_letters(id),
  position INTEGER NOT NULL,
  
  lob_letter_id TEXT,
  lob_url TEXT,
  
  status TEXT DEFAULT 'created',
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  delivered_at TIMESTAMP WITH TIME ZONE,
  
  cost_cents INTEGER
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_enrollments_agent ON mail_enrollments(agent_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_zip ON mail_enrollments(zip_code);
CREATE INDEX IF NOT EXISTS idx_enrollments_status ON mail_enrollments(status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_letters_enrollment ON mail_letters(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_sends_enrollment ON mail_sends(enrollment_id);

-- ============================================================
-- 3. RPC FUNCTION — atomic credit decrement
-- ============================================================

CREATE OR REPLACE FUNCTION decrement_mail_credits(agent TEXT)
RETURNS void AS $$
BEGIN
  UPDATE mail_credits 
  SET credits_remaining = credits_remaining - 1,
      credits_used = credits_used + 1
  WHERE user_id = agent 
    AND credits_remaining > 0;
    
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No credits remaining for agent %', agent;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

-- Enable RLS on new tables
ALTER TABLE mail_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_sends ENABLE ROW LEVEL SECURITY;

-- Anon can read territory status (for the territories page)
DO $$
BEGIN
  DROP POLICY IF EXISTS "Anon can read territory status" ON territory_claims;
  CREATE POLICY "Anon can read territory status" ON territory_claims
    FOR SELECT TO anon USING (true);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Policy creation: %', SQLERRM;
END $$;

-- Service role handles all writes (via SUPABASE_SERVICE_KEY in server.js)
-- No additional policies needed for service role

-- ============================================================
-- 5. VERIFY
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
  tbls TEXT[] := ARRAY['territory_claims','mail_credits','mail_enrollments','mail_letters','mail_sends'];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = tbl) THEN
      RAISE NOTICE '✓ % exists', tbl;
    ELSE
      RAISE NOTICE '✗ % MISSING', tbl;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 6. SALE DETECTIONS — automatic tracking of sold parcels
-- ============================================================
CREATE TABLE IF NOT EXISTS sale_detections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  owner_name TEXT,
  address TEXT,
  sale_price INTEGER,
  sale_date TEXT,
  score_at_flag INTEGER,
  cohort TEXT,
  detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(parcel_id)
);

CREATE INDEX IF NOT EXISTS idx_sale_detections_zip ON sale_detections(zip_code);
ALTER TABLE sale_detections ENABLE ROW LEVEL SECURITY;
