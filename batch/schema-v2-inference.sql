-- SellerSignal v2: Full-Universe Seller-State Inference
-- Run in Supabase SQL Editor

-- Core inference output table — one row per parcel per run
CREATE TABLE IF NOT EXISTS seller_state_inference (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parcel_id TEXT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,
  market_key TEXT NOT NULL,
  model_version TEXT NOT NULL DEFAULT 'seller_state_v1',
  
  -- Structured inference outputs
  ownership_archetype TEXT NOT NULL DEFAULT 'unknown',
  seller_state TEXT NOT NULL DEFAULT 'stable_hold',
  pressure_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeline_bucket TEXT NOT NULL DEFAULT 'unclear',
  preferred_outreach TEXT NOT NULL DEFAULT 'watch_only',
  
  -- Numeric scores (0-1)
  seller_intent_score NUMERIC NOT NULL DEFAULT 0,
  off_market_receptivity NUMERIC NOT NULL DEFAULT 0,
  contactability NUMERIC NOT NULL DEFAULT 0,
  false_positive_risk NUMERIC NOT NULL DEFAULT 1,
  confidence NUMERIC NOT NULL DEFAULT 0,
  
  -- Reasoning
  top_reason TEXT,
  main_blocker TEXT,
  evidence_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  
  -- Ranking (computed from scores)
  briefing_rank NUMERIC NOT NULL DEFAULT 0,
  act_tier TEXT NOT NULL DEFAULT 'watch',
  
  -- Cache control
  truth_hash TEXT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(parcel_id)
);

CREATE INDEX IF NOT EXISTS idx_ssi_zip ON seller_state_inference(zip_code);
CREATE INDEX IF NOT EXISTS idx_ssi_rank ON seller_state_inference(zip_code, briefing_rank DESC);
CREATE INDEX IF NOT EXISTS idx_ssi_tier ON seller_state_inference(zip_code, act_tier, briefing_rank DESC);
CREATE INDEX IF NOT EXISTS idx_ssi_hash ON seller_state_inference(truth_hash);
CREATE INDEX IF NOT EXISTS idx_ssi_market ON seller_state_inference(market_key);

ALTER TABLE seller_state_inference ENABLE ROW LEVEL SECURITY;

-- Briefing view: join parcels + inference for single read
CREATE OR REPLACE VIEW briefing_view AS
SELECT 
  p.id AS parcel_id,
  p.zip_code,
  p.market_key,
  p.owner_name,
  p.owner_type,
  p.address,
  p.city,
  p.state,
  p.lat,
  p.lng,
  p.assessed_value,
  p.building_value,
  p.land_value,
  p.year_built,
  p.sqft,
  p.acres,
  p.subdivision,
  p.prop_type,
  p.is_vacant_land,
  p.is_absentee,
  p.is_out_of_state,
  p.owner_state,
  p.mailing_address,
  p.mailing_city,
  p.mailing_state,
  p.mailing_zip,
  p.tenure_years,
  p.last_transfer_date,
  p.sale_price,
  s.ownership_archetype,
  s.seller_state,
  s.pressure_sources,
  s.timeline_bucket,
  s.preferred_outreach,
  s.seller_intent_score,
  s.off_market_receptivity,
  s.contactability,
  s.false_positive_risk,
  s.confidence,
  s.top_reason,
  s.main_blocker,
  s.evidence_keys,
  s.briefing_rank,
  s.act_tier,
  s.model_version,
  s.computed_at AS inference_computed_at
FROM parcels p
LEFT JOIN seller_state_inference s ON s.parcel_id = p.id;

-- Investigation cache — stores Layer 3 results per parcel
CREATE TABLE IF NOT EXISTS investigation_cache (
  parcel_id TEXT PRIMARY KEY REFERENCES parcels(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,
  search_count INTEGER NOT NULL DEFAULT 0,
  signal_count INTEGER NOT NULL DEFAULT 0,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  enhanced_claims JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_result_count INTEGER NOT NULL DEFAULT 0,
  investigated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  truth_hash_at_investigation TEXT
);

CREATE INDEX IF NOT EXISTS idx_inv_cache_zip ON investigation_cache(zip_code);
CREATE INDEX IF NOT EXISTS idx_inv_cache_expires ON investigation_cache(expires_at);
ALTER TABLE investigation_cache ENABLE ROW LEVEL SECURITY;
