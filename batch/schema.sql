-- SellerSignal Batch Pipeline — Supabase Migration
-- Run in Supabase SQL Editor after the initial setup

-- =============================================
-- 1. PARCELS — every property across all markets
-- =============================================
CREATE TABLE IF NOT EXISTS parcels (
  id TEXT PRIMARY KEY,                    -- market-specific parcel ID (e.g. "FL_MD-33134-12345")
  zip_code TEXT NOT NULL,
  market_key TEXT NOT NULL,               -- e.g. "FL_MD", "NC", "WA_KING"
  
  -- Owner info
  owner_name TEXT,
  owner_type TEXT,                        -- individual, trust, estate, llc_corp, estate_heirs
  
  -- Property info
  address TEXT,
  city TEXT,
  state TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  assessed_value INTEGER,
  building_value INTEGER,
  land_value INTEGER,
  year_built INTEGER,
  sqft INTEGER,
  bedrooms INTEGER,
  acres DOUBLE PRECISION,
  subdivision TEXT,
  prop_type TEXT,                          -- Residential, Vacant Land, Commercial, etc.
  is_vacant_land BOOLEAN DEFAULT FALSE,
  
  -- Ownership signals
  is_absentee BOOLEAN DEFAULT FALSE,
  is_out_of_state BOOLEAN DEFAULT FALSE,
  owner_state TEXT,                        -- mailing state
  mailing_address TEXT,
  mailing_city TEXT,
  mailing_state TEXT,
  mailing_zip TEXT,
  multi_count INTEGER DEFAULT 1,           -- # properties same owner holds in ZIP
  
  -- Transfer/tenure
  last_transfer_year INTEGER,
  last_transfer_date TEXT,
  sale_price INTEGER,
  tenure_years DOUBLE PRECISION,
  
  -- Raw attributes (full GIS response for debugging)
  raw_attributes JSONB,
  
  -- Timestamps
  fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================
-- 2. SCORES — computed scores per parcel
-- =============================================
CREATE TABLE IF NOT EXISTS parcel_scores (
  parcel_id TEXT PRIMARY KEY REFERENCES parcels(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,
  market_key TEXT NOT NULL,
  
  -- Heuristic scores (pre-filter)
  seller_likelihood INTEGER,
  off_market_receptivity INTEGER,
  actionability INTEGER,
  confidence INTEGER,
  briefing_rank INTEGER,                   -- composite weighted score
  score_class TEXT,                         -- high, medium, low
  cohort TEXT,                             -- residential, trust, estate, investor, etc.
  
  -- Calibrated scores (after backtest calibration applied)
  calibrated_rank INTEGER,
  
  -- AI Lite scores (from unified intelligence scorer)
  lite_score INTEGER,
  lite_headline TEXT,
  lite_archetype TEXT,
  lite_rationale TEXT,
  
  -- Evidence signals
  signals JSONB,                           -- array of {text, type} signal objects
  evidence JSONB,                          -- full evidence bundle
  
  scored_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================
-- 3. DEEP_SIGNALS — full AI intelligence reports for top prospects
-- =============================================
CREATE TABLE IF NOT EXISTS deep_signals (
  parcel_id TEXT PRIMARY KEY REFERENCES parcels(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,
  
  -- Full intelligence report
  report JSONB NOT NULL,                   -- the complete Deep Signal response
  
  -- Extracted key fields for fast access
  motivation TEXT,
  timeline TEXT,
  best_channel TEXT,                        -- call, mail, door
  call_script TEXT,
  mail_script TEXT,
  door_script TEXT,
  what_not_to_say TEXT,
  
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================
-- 4. ZIP_BRIEFINGS — pre-computed briefing summaries per ZIP
-- =============================================
CREATE TABLE IF NOT EXISTS zip_briefings (
  zip_code TEXT PRIMARY KEY,
  market_key TEXT NOT NULL,
  market_name TEXT,
  
  -- Stats
  total_parcels INTEGER,
  unique_owners INTEGER,
  act_today_count INTEGER,
  outreach_queue_count INTEGER,
  
  -- Pre-computed lists (parcel IDs, ordered by rank)
  act_today_ids TEXT[],                    -- top 5-15 parcel IDs
  outreach_queue_ids TEXT[],               -- next 30-50 parcel IDs
  
  -- Calibration data
  calibration JSONB,                       -- backtest results, feature rates, lifts
  
  -- Metadata
  computed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  computation_time_ms INTEGER              -- how long the batch took
);

-- =============================================
-- 5. BATCH_RUNS — audit log of batch processing
-- =============================================
CREATE TABLE IF NOT EXISTS batch_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'running',           -- running, completed, failed
  
  zips_processed INTEGER DEFAULT 0,
  parcels_processed INTEGER DEFAULT 0,
  lite_calls INTEGER DEFAULT 0,
  deep_signal_calls INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]'::jsonb,
  
  -- Cost tracking
  estimated_api_cost NUMERIC(10,2)
);

-- =============================================
-- 6. TERRITORY CLAIMS — which agent owns which ZIP
-- =============================================
CREATE TABLE IF NOT EXISTS territory_claims (
  zip_code TEXT PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  market_key TEXT NOT NULL,
  claimed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status TEXT DEFAULT 'active',            -- active, cancelled, pending
  stripe_subscription_id TEXT,
  monthly_price INTEGER DEFAULT 1000       -- cents? no, dollars
);

-- =============================================
-- INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_parcels_zip ON parcels(zip_code);
CREATE INDEX IF NOT EXISTS idx_parcels_market ON parcels(market_key);
CREATE INDEX IF NOT EXISTS idx_parcels_owner_type ON parcels(owner_type);
CREATE INDEX IF NOT EXISTS idx_scores_zip ON parcel_scores(zip_code);
CREATE INDEX IF NOT EXISTS idx_scores_rank ON parcel_scores(briefing_rank DESC);
CREATE INDEX IF NOT EXISTS idx_scores_calibrated ON parcel_scores(calibrated_rank DESC);
CREATE INDEX IF NOT EXISTS idx_scores_lite ON parcel_scores(lite_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_deep_signals_zip ON deep_signals(zip_code);
CREATE INDEX IF NOT EXISTS idx_territory_user ON territory_claims(user_id);

-- =============================================
-- RLS POLICIES
-- =============================================
ALTER TABLE parcels ENABLE ROW LEVEL SECURITY;
ALTER TABLE parcel_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE deep_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE zip_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE territory_claims ENABLE ROW LEVEL SECURITY;

-- Parcels/scores/briefings: readable by anyone with a claimed territory
CREATE POLICY "Users can read parcels in their territory" ON parcels
  FOR SELECT USING (
    zip_code IN (SELECT zip_code FROM territory_claims WHERE user_id = auth.uid() AND status = 'active')
  );

CREATE POLICY "Users can read scores in their territory" ON parcel_scores
  FOR SELECT USING (
    zip_code IN (SELECT zip_code FROM territory_claims WHERE user_id = auth.uid() AND status = 'active')
  );

CREATE POLICY "Users can read deep signals in their territory" ON deep_signals
  FOR SELECT USING (
    zip_code IN (SELECT zip_code FROM territory_claims WHERE user_id = auth.uid() AND status = 'active')
  );

CREATE POLICY "Users can read briefings for their territory" ON zip_briefings
  FOR SELECT USING (
    zip_code IN (SELECT zip_code FROM territory_claims WHERE user_id = auth.uid() AND status = 'active')
  );

-- Territory claims: users see their own
CREATE POLICY "Users can read own claims" ON territory_claims
  FOR SELECT USING (user_id = auth.uid());

-- Service role (batch worker) can write everything — handled by SUPABASE_SERVICE_KEY

-- Done!
